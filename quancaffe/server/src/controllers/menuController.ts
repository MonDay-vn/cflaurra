import { Request, Response } from 'express';
import { db } from '../db/database.js';
import { kdsHub } from '../sockets/kdsHub.js';

export class MenuController {
  public static getMenu(req: Request, res: Response) {
    try {
      const groups = db.prepare('SELECT * FROM NHOM_MON ORDER BY ThuTuHienThi ASC').all() as any[];
      const items = db.prepare('SELECT * FROM DANH_MUC_MON ORDER BY MaMon ASC').all() as any[];

      items.forEach(i => {
        i.is_available = i.DangKinhDoanh === 1;
      });

      const menu = groups.map(g => ({
        ...g,
        items: items.filter(i => i.MaNhom === g.MaNhom)
      }));

      res.json({ success: true, data: { groups, items, menu } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static toggleMenuItemStock(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const item = db.prepare('SELECT * FROM DANH_MUC_MON WHERE MaMon = ?').get(id) as any;
      if (!item) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy món' });
      }

      let nextStatus: number;
      if (req.body && req.body.is_available !== undefined) {
        nextStatus = req.body.is_available ? 1 : 0;
      } else if (req.body && req.body.dangKinhDoanh !== undefined) {
        nextStatus = req.body.dangKinhDoanh ? 1 : 0;
      } else {
        nextStatus = item.DangKinhDoanh === 1 ? 0 : 1;
      }

      db.prepare('UPDATE DANH_MUC_MON SET DangKinhDoanh = ? WHERE MaMon = ?').run(nextStatus, id);
      kdsHub.broadcast('MENU_UPDATED', {
        maMon: id,
        tenMon: item.TenMon,
        dangKinhDoanh: nextStatus,
        is_available: nextStatus === 1
      });

      res.json({
        success: true,
        data: { maMon: id, tenMon: item.TenMon, dangKinhDoanh: nextStatus, is_available: nextStatus === 1 },
        message: `Món "${item.TenMon}" đã chuyển sang trạng thái: ${nextStatus === 1 ? '🟢 Đang kinh doanh' : '🔴 Tạm hết món'}`
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static getTables(req: Request, res: Response) {
    try {
      const areas = db.prepare('SELECT * FROM KHU_VUC').all() as any[];
      const tables = db.prepare(`
        SELECT b.*, k.TenKhuVuc,
          (SELECT SoHoaDon FROM HOA_DON_BAN_HANG hd 
           WHERE hd.MaBan = b.MaBan AND hd.TrangThaiThanhToan = 'ChoThanhToan' 
           LIMIT 1) as CurrentOrder
        FROM BAN b
        JOIN KHU_VUC k ON b.MaKhuVuc = k.MaKhuVuc
      `).all() as any[];

      res.json({ success: true, data: { areas, tables } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static updateTableStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { trangThai } = req.body;

      if (!trangThai) {
        return res.status(400).json({ success: false, message: 'Thiếu trạng thái bàn' });
      }

      if (trangThai === 'Trong') {
        // Hủy bất kỳ đơn hàng chờ thanh toán còn dang dở của bàn này khi đưa về bàn trống
        db.prepare(`
          UPDATE HOA_DON_BAN_HANG 
          SET TrangThaiThanhToan = 'DaHuy', GhiChu = COALESCE(GhiChu, '') || ' (Đóng bàn trực tiếp)'
          WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan'
        `).run(id);
      }

      db.prepare('UPDATE BAN SET TrangThai = ? WHERE MaBan = ?').run(trangThai, id);
      kdsHub.broadcast('TABLE_UPDATED', { maBan: id, trangThai });

      res.json({ success: true, message: 'Cập nhật trạng thái bàn thành công' });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static transferTable(req: Request, res: Response) {
    try {
      const { fromTable, toTable } = req.body;
      if (!fromTable || !toTable) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn bàn nguồn và bàn đích' });
      }

      db.exec('BEGIN TRANSACTION;');
      // Chuyển tất cả hóa đơn chưa thanh toán sang bàn mới
      db.prepare(`
        UPDATE HOA_DON_BAN_HANG
        SET MaBan = ?
        WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan'
      `).run(toTable, fromTable);

      // Cập nhật trạng thái 2 bàn
      db.prepare("UPDATE BAN SET TrangThai = 'Trong' WHERE MaBan = ?").run(fromTable);
      db.prepare("UPDATE BAN SET TrangThai = 'CoKhach' WHERE MaBan = ?").run(toTable);

      db.exec('COMMIT;');

      kdsHub.broadcast('TABLE_UPDATED', { maBan: fromTable, trangThai: 'Trong' });
      kdsHub.broadcast('TABLE_UPDATED', { maBan: toTable, trangThai: 'CoKhach' });

      res.json({ success: true, message: `Đã chuyển từ ${fromTable} sang ${toTable} thành công!` });
    } catch (err: any) {
      db.exec('ROLLBACK;');
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static mergeTables(req: Request, res: Response) {
    try {
      const fromTable = req.body.fromTable || req.body.fromTableId;
      const toTable = req.body.toTable || req.body.toTableId;
      if (!fromTable || !toTable) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn bàn nguồn và bàn đích cần ghép' });
      }

      if (fromTable === toTable) {
        return res.status(400).json({ success: false, message: 'Không thể ghép bàn vào chính nó' });
      }

      const tblFrom = db.prepare('SELECT * FROM BAN WHERE MaBan = ?').get(fromTable) as any;
      const tblTo = db.prepare('SELECT * FROM BAN WHERE MaBan = ?').get(toTable) as any;

      if (!tblFrom || !tblTo) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy thông tin bàn cần ghép' });
      }

      // Lấy hóa đơn đang chờ thanh toán của cả 2 bàn
      const fromOrder = db.prepare(`
        SELECT * FROM HOA_DON_BAN_HANG 
        WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan'
        ORDER BY NgayGioLap DESC LIMIT 1
      `).get(fromTable) as any;

      const toOrder = db.prepare(`
        SELECT * FROM HOA_DON_BAN_HANG 
        WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan'
        ORDER BY NgayGioLap DESC LIMIT 1
      `).get(toTable) as any;

      db.exec('BEGIN TRANSACTION;');

      let finalOrderId: string | null = null;

      if (fromOrder && toOrder) {
        // Cả 2 bàn đều có hóa đơn: chuyển chi tiết món từ fromOrder sang toOrder
        db.prepare(`
          UPDATE CHI_TIET_HOA_DON
          SET SoHoaDon = ?
          WHERE SoHoaDon = ?
        `).run(toOrder.SoHoaDon, fromOrder.SoHoaDon);

        // Tính lại tổng tiền món sau khi gộp
        const sumResult = db.prepare(`
          SELECT COALESCE(SUM(ThanhTien), 0) as total
          FROM CHI_TIET_HOA_DON
          WHERE SoHoaDon = ?
        `).get(toOrder.SoHoaDon) as any;

        const newTotal = sumResult ? sumResult.total : (toOrder.TongTienMon + fromOrder.TongTienMon);
        const note = `[Ghép từ ${tblFrom.TenBan}] ${toOrder.GhiChu || ''}`.trim();

        db.prepare(`
          UPDATE HOA_DON_BAN_HANG
          SET TongTienMon = ?, GhiChu = ?
          WHERE SoHoaDon = ?
        `).run(newTotal, note, toOrder.SoHoaDon);

        // Hủy hóa đơn cũ của fromTable (đã gộp món xong)
        db.prepare(`
          UPDATE HOA_DON_BAN_HANG
          SET TrangThaiThanhToan = 'DaHuy', GhiChu = ?
          WHERE SoHoaDon = ?
        `).run(`Đã ghép vào hóa đơn ${toOrder.SoHoaDon} (${tblTo.TenBan})`, fromOrder.SoHoaDon);

        finalOrderId = toOrder.SoHoaDon;
      } else if (fromOrder && !toOrder) {
        // Bàn nguồn có hóa đơn nhưng bàn đích chưa có: chuyển hóa đơn sang bàn đích
        const note = `[Ghép từ ${tblFrom.TenBan}] ${fromOrder.GhiChu || ''}`.trim();
        db.prepare(`
          UPDATE HOA_DON_BAN_HANG
          SET MaBan = ?, GhiChu = ?
          WHERE SoHoaDon = ?
        `).run(toTable, note, fromOrder.SoHoaDon);

        finalOrderId = fromOrder.SoHoaDon;
      } else if (!fromOrder && toOrder) {
        finalOrderId = toOrder.SoHoaDon;
      }

      // Trả bàn nguồn về Bàn Trống
      db.prepare("UPDATE BAN SET TrangThai = 'Trong' WHERE MaBan = ?").run(fromTable);
      // Bàn đích trở thành Có Khách
      db.prepare("UPDATE BAN SET TrangThai = 'CoKhach' WHERE MaBan = ?").run(toTable);

      db.exec('COMMIT;');

      // Phát WebSocket thông báo tức thời cho toàn bộ hệ thống POS & KDS
      kdsHub.broadcast('TABLE_UPDATED', { maBan: fromTable, trangThai: 'Trong' });
      kdsHub.broadcast('TABLE_UPDATED', { maBan: toTable, trangThai: 'CoKhach' });
      if (finalOrderId) {
        kdsHub.broadcast('ORDER_UPDATED', { soHoaDon: finalOrderId, maBan: toTable });
      }

      res.json({
        success: true,
        message: `Đã ghép ${tblFrom.TenBan} vào ${tblTo.TenBan} thành công!`,
        data: {
          fromTable,
          toTable,
          fromTableName: tblFrom.TenBan,
          toTableName: tblTo.TenBan,
          finalOrderId
        }
      });
    } catch (err: any) {
      db.exec('ROLLBACK;');
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Tạo món mới vào thực đơn (DANH_MUC_MON) kèm hỗ trợ ảnh & công thức định mức nguyên liệu
   */
  public static createMenuItem(req: Request, res: Response) {
    try {
      const { tenMon, maNhom, donViTinh = 'Ly', giaBanHienHanh, hinhAnh, dangKinhDoanh = 1, ingredients } = req.body;

      if (!tenMon || !tenMon.trim()) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập tên món đồ uống / món ăn' });
      }

      const price = Number(giaBanHienHanh);
      if (isNaN(price) || price < 0) {
        return res.status(400).json({ success: false, message: 'Đơn giá bán không hợp lệ' });
      }

      // Tự sinh mã món an toàn: M01, M02 ... M12
      const maxRow = db.prepare(`
        SELECT COALESCE(MAX(CAST(SUBSTR(MaMon, 2) AS INTEGER)), 0) as maxNum
        FROM DANH_MUC_MON
        WHERE MaMon LIKE 'M%'
      `).get() as any;
      const nextNum = ((maxRow?.maxNum || 0) + 1).toString().padStart(2, '0');
      const maMon = `M${nextNum}`;

      const finalHinhAnh = (hinhAnh && hinhAnh.trim())
        ? hinhAnh.trim()
        : 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=400&auto=format&fit=crop&q=80';

      const finalNhom = maNhom || 'GRP_CFE';
      const finalDvt = donViTinh || 'Ly';

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          INSERT INTO DANH_MUC_MON (MaMon, TenMon, MaNhom, DonViTinh, GiaBanHienHanh, HinhAnh, DangKinhDoanh)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(maMon, tenMon.trim(), finalNhom, finalDvt, price, finalHinhAnh, dangKinhDoanh ? 1 : 0);

        // Lưu công thức định mức nguyên vật liệu nếu có
        if (Array.isArray(ingredients) && ingredients.length > 0) {
          for (const ing of ingredients) {
            const vId = ing.maVatTu;
            const qty = parseFloat(ing.soLuongDinhMuc);
            const note = (ing.ghiChu || '').trim();
            if (!vId || isNaN(qty) || qty <= 0) continue;

            const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(vId);
            if (!mat) continue;

            const unit = ing.donViTinh || mat.DonViTinh || 'g';
            const maCongThuc = `CT_${maMon}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
            db.prepare(`
              INSERT INTO CONG_THUC_MON (MaCongThuc, MaMon, MaVatTu, SoLuongDinhMuc, DonViTinh, GhiChu)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(maCongThuc, maMon, vId, qty, unit, note);
          }
        }

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      kdsHub.broadcast('MENU_UPDATED', { maMon, tenMon: tenMon.trim(), action: 'created' });

      res.status(201).json({
        success: true,
        message: `Đã thêm món "${tenMon.trim()}" (${maMon}) kèm công thức vào thực đơn thành công!`,
        data: {
          maMon,
          tenMon: tenMon.trim(),
          maNhom: finalNhom,
          donViTinh: finalDvt,
          giaBanHienHanh: price,
          hinhAnh: finalHinhAnh,
          dangKinhDoanh: dangKinhDoanh ? 1 : 0
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Cập nhật thông tin món, ảnh & công thức trong thực đơn
   */
  public static updateMenuItem(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { tenMon, maNhom, donViTinh, giaBanHienHanh, hinhAnh, dangKinhDoanh, ingredients } = req.body;

      const item = db.prepare('SELECT * FROM DANH_MUC_MON WHERE MaMon = ?').get(id) as any;
      if (!item) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy món cần cập nhật' });
      }

      const price = giaBanHienHanh !== undefined ? Number(giaBanHienHanh) : item.GiaBanHienHanh;

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          UPDATE DANH_MUC_MON
          SET TenMon = COALESCE(?, TenMon),
              MaNhom = COALESCE(?, MaNhom),
              DonViTinh = COALESCE(?, DonViTinh),
              GiaBanHienHanh = ?,
              HinhAnh = COALESCE(?, HinhAnh),
              DangKinhDoanh = COALESCE(?, DangKinhDoanh)
          WHERE MaMon = ?
        `).run(
          tenMon ? tenMon.trim() : null,
          maNhom ?? null,
          donViTinh ?? null,
          price,
          hinhAnh ?? null,
          dangKinhDoanh !== undefined ? (dangKinhDoanh ? 1 : 0) : null,
          id
        );

        // Cập nhật lại công thức nguyên vật liệu nếu mảng ingredients được gửi lên
        if (Array.isArray(ingredients)) {
          db.prepare('DELETE FROM CONG_THUC_MON WHERE MaMon = ?').run(id);

          for (const ing of ingredients) {
            const vId = ing.maVatTu;
            const qty = parseFloat(ing.soLuongDinhMuc);
            const note = (ing.ghiChu || '').trim();
            if (!vId || isNaN(qty) || qty <= 0) continue;

            const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(vId);
            if (!mat) continue;

            const unit = ing.donViTinh || mat.DonViTinh || 'g';
            const maCongThuc = `CT_${id}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
            db.prepare(`
              INSERT INTO CONG_THUC_MON (MaCongThuc, MaMon, MaVatTu, SoLuongDinhMuc, DonViTinh, GhiChu)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(maCongThuc, id, vId, qty, unit, note);
          }
        }

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      kdsHub.broadcast('MENU_UPDATED', { maMon: id, action: 'updated' });

      res.json({ success: true, message: `Đã cập nhật món "${tenMon || item.TenMon}" và công thức thành công!` });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Xóa hoặc ngừng kinh doanh món
   */
  public static deleteMenuItem(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const item = db.prepare('SELECT * FROM DANH_MUC_MON WHERE MaMon = ?').get(id) as any;
      if (!item) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy món' });
      }

      // Kiểm tra xem món đã từng được bán trong hóa đơn nào chưa
      const checkOrders = db.prepare('SELECT COUNT(*) as cnt FROM CHI_TIET_HOA_DON WHERE MaMon = ?').get(id) as any;

      if (checkOrders && checkOrders.cnt > 0) {
        // Đã từng bán -> Xóa mềm (Ngừng kinh doanh) để bảo toàn báo cáo doanh thu & lịch sử hóa đơn
        db.prepare('UPDATE DANH_MUC_MON SET DangKinhDoanh = 0 WHERE MaMon = ?').run(id);
        kdsHub.broadcast('MENU_UPDATED', { maMon: id, action: 'disabled' });
        return res.json({
          success: true,
          message: `Món "${item.TenMon}" đã từng phát sinh hóa đơn bán hàng nên được chuyển sang trạng thái "Ngừng kinh doanh" an toàn.`
        });
      }

      // Chưa từng bán -> Xóa hoàn toàn
      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare('DELETE FROM CONG_THUC_MON WHERE MaMon = ?').run(id);
        db.prepare('DELETE FROM DANH_MUC_MON WHERE MaMon = ?').run(id);
        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }

      kdsHub.broadcast('MENU_UPDATED', { maMon: id, action: 'deleted' });
      res.json({ success: true, message: `Đã xóa món "${item.TenMon}" khỏi thực đơn.` });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
