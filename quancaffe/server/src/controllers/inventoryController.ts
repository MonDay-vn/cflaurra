import { Request, Response } from 'express';
import { db } from '../db/database.js';

export class InventoryController {
  public static getMaterials(req: Request, res: Response) {
    try {
      const materials = db.prepare(`
        SELECT *, 
               CASE WHEN SoLuongTonHienTai <= MucToiThieuCanCanhBao THEN 1 ELSE 0 END as CanhBaoHetHang
        FROM VAT_TU_NGUYEN_LIEU
        ORDER BY CanhBaoHetHang DESC, TenVatTu ASC
      `).all();

      res.json({ success: true, data: materials });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static getRecipes(req: Request, res: Response) {
    try {
      const { maMon } = req.query;
      let query = `
        SELECT c.*, m.TenMon, m.MaNhom, m.GiaBanHienHanh, v.TenVatTu, v.SoLuongTonHienTai, v.DonGiaBinhQuan, v.DonViTinh as DonViTinhVatTu
        FROM CONG_THUC_MON c
        JOIN DANH_MUC_MON m ON c.MaMon = m.MaMon
        JOIN VAT_TU_NGUYEN_LIEU v ON c.MaVatTu = v.MaVatTu
      `;
      const params: any[] = [];
      if (maMon) {
        query += ` WHERE c.MaMon = ?`;
        params.push(maMon);
      }
      query += ` ORDER BY m.TenMon ASC, c.MaCongThuc ASC`;

      const recipes = db.prepare(query).all(...params);
      res.json({ success: true, data: recipes });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static createRecipe(req: Request, res: Response) {
    try {
      const { maMon, ingredients, maVatTu, soLuongDinhMuc, donViTinh, ghiChu, replace } = req.body;

      if (!maMon) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn món đồ uống cần lập công thức' });
      }

      const mon: any = db.prepare('SELECT * FROM DANH_MUC_MON WHERE MaMon = ?').get(maMon);
      if (!mon) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy món đồ uống trong hệ thống' });
      }

      let rawList: any[] = [];
      if (Array.isArray(ingredients)) {
        rawList = ingredients;
      } else if (maVatTu) {
        rawList = [{ maVatTu, soLuongDinhMuc, donViTinh, ghiChu }];
      } else {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn ít nhất một nguyên vật liệu cho công thức' });
      }

      db.exec('BEGIN TRANSACTION;');
      try {
        if (replace) {
          db.prepare('DELETE FROM CONG_THUC_MON WHERE MaMon = ?').run(maMon);
        }

        let insertedCount = 0;
        let updatedCount = 0;

        for (const item of rawList) {
          const vId = item.maVatTu;
          const qty = parseFloat(item.soLuongDinhMuc);
          const note = (item.ghiChu || '').trim();

          if (!vId || isNaN(qty) || qty <= 0) {
            continue;
          }

          const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(vId);
          if (!mat) continue;

          const unit = item.donViTinh || mat.DonViTinh || 'g';

          const existing: any = replace ? null : db.prepare(`
            SELECT MaCongThuc FROM CONG_THUC_MON WHERE MaMon = ? AND MaVatTu = ?
          `).get(maMon, vId);

          if (existing) {
            db.prepare(`
              UPDATE CONG_THUC_MON
              SET SoLuongDinhMuc = ?, DonViTinh = ?, GhiChu = ?
              WHERE MaCongThuc = ?
            `).run(qty, unit, note, existing.MaCongThuc);
            updatedCount++;
          } else {
            const maCongThuc = `CT_${maMon}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
            db.prepare(`
              INSERT INTO CONG_THUC_MON (MaCongThuc, MaMon, MaVatTu, SoLuongDinhMuc, DonViTinh, GhiChu)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(maCongThuc, maMon, vId, qty, unit, note);
            insertedCount++;
          }
        }

        db.exec('COMMIT;');

        res.status(201).json({
          success: true,
          message: `Đã lưu công thức cho món "${mon.TenMon}" thành công! (${insertedCount} thêm mới, ${updatedCount} cập nhật)`
        });
      } catch (txErr) {
        db.exec('ROLLBACK;');
        throw txErr;
      }
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static updateRecipe(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { soLuongDinhMuc, donViTinh, ghiChu, maVatTu } = req.body;

      const existing: any = db.prepare('SELECT * FROM CONG_THUC_MON WHERE MaCongThuc = ?').get(id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy mục công thức cần sửa' });
      }

      const qty = parseFloat(soLuongDinhMuc);
      if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Số lượng định mức phải lớn hơn 0' });
      }

      let newMat = existing.MaVatTu;
      let newUnit = donViTinh || existing.DonViTinh;

      if (maVatTu && maVatTu !== existing.MaVatTu) {
        const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(maVatTu);
        if (!mat) {
          return res.status(404).json({ success: false, message: 'Không tìm thấy nguyên vật liệu thay thế' });
        }
        newMat = maVatTu;
        if (!donViTinh) newUnit = mat.DonViTinh;
      }

      db.prepare(`
        UPDATE CONG_THUC_MON
        SET MaVatTu = ?, SoLuongDinhMuc = ?, DonViTinh = ?, GhiChu = ?
        WHERE MaCongThuc = ?
      `).run(newMat, qty, newUnit, ghiChu !== undefined ? ghiChu : existing.GhiChu, id);

      res.json({ success: true, message: 'Đã cập nhật định mức công thức thành công!' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static deleteRecipe(req: Request, res: Response) {
    try {
      const { id } = req.params;

      let result = db.prepare('DELETE FROM CONG_THUC_MON WHERE MaCongThuc = ?').run(id);
      if (result.changes === 0) {
        result = db.prepare('DELETE FROM CONG_THUC_MON WHERE MaMon = ?').run(id);
      }

      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy công thức cần xóa' });
      }

      res.json({ success: true, message: 'Đã xóa nguyên liệu khỏi công thức thành công!' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static getSuppliers(req: Request, res: Response) {
    try {
      const suppliers = db.prepare('SELECT * FROM NHA_CUNG_CAP ORDER BY TenNCC ASC').all();
      res.json({ success: true, data: suppliers });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static importStock(req: Request, res: Response) {
    try {
      const { maVatTu, soLuong, donGia, maNCC, maNhanVien = 'NV01', ghiChu } = req.body;
      const qty = parseFloat(soLuong);
      const price = parseFloat(donGia);

      if (!maVatTu || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Số lượng nhập không hợp lệ' });
      }

      const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(maVatTu);
      if (!mat) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy nguyên vật liệu' });
      }

      const unitPrice = isNaN(price) || price <= 0 ? mat.DonGiaBinhQuan : price;
      const thanhTien = qty * unitPrice;
      const soPhieuNhap = `PNK_${Date.now()}`;
      const defaultNCC = maNCC || 'NCC01';

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          INSERT INTO PHIEU_NHAP_KHO (SoPhieuNhap, NgayNhap, MaNCC, MaNhanVien, TongTienNhap, TrangThai, GhiChu)
          VALUES (?, datetime('now'), ?, ?, ?, 'DaNhap', ?)
        `).run(soPhieuNhap, defaultNCC, maNhanVien, thanhTien, ghiChu || 'Nhập bổ sung kho');

        db.prepare(`
          INSERT INTO CHI_TIET_PHIEU_NHAP (SoPhieuNhap, MaVatTu, SoLuongNhap, DonGiaNhap, ThanhTien)
          VALUES (?, ?, ?, ?, ?)
        `).run(soPhieuNhap, maVatTu, qty, unitPrice, thanhTien);

        const currentQty = mat.SoLuongTonHienTai || 0;
        const currentPrice = mat.DonGiaBinhQuan || 0;
        const newQty = currentQty + qty;
        const newAvgPrice = newQty > 0 ? Math.round(((currentQty * currentPrice) + (qty * unitPrice)) / newQty) : unitPrice;

        db.prepare(`
          UPDATE VAT_TU_NGUYEN_LIEU 
          SET SoLuongTonHienTai = ?, DonGiaBinhQuan = ?
          WHERE MaVatTu = ?
        `).run(newQty, newAvgPrice, maVatTu);

        db.exec('COMMIT;');
      } catch (txErr) {
        db.exec('ROLLBACK;');
        throw txErr;
      }

      res.json({ 
        success: true, 
        message: `Đã nhập thành công ${qty} ${mat.DonViTinh} ${mat.TenVatTu}!`,
        data: { soPhieuNhap, thanhTien }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static reportLoss(req: Request, res: Response) {
    try {
      const { maVatTu, soLuong, lyDo = 'Hao hụt kiểm kê', maNhanVien = 'NV01' } = req.body;
      const qty = parseFloat(soLuong);

      if (!maVatTu || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Số lượng hao hụt không hợp lệ' });
      }

      const mat: any = db.prepare('SELECT * FROM VAT_TU_NGUYEN_LIEU WHERE MaVatTu = ?').get(maVatTu);
      if (!mat) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy nguyên vật liệu' });
      }

      const actualLossQty = Math.min(qty, mat.SoLuongTonHienTai);
      const giaTriHaoHut = actualLossQty * (mat.DonGiaBinhQuan || 0);
      const soPhieuHuy = `PHH_${Date.now()}`;

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          INSERT INTO PHIEU_HUY_HAO_HUT (SoPhieuHuy, NgayHuy, MaNhanVien, TongGiaTriHaoHut, LyDoHaoHut)
          VALUES (?, datetime('now'), ?, ?, ?)
        `).run(soPhieuHuy, maNhanVien, giaTriHaoHut, lyDo);

        db.prepare(`
          INSERT INTO CHI_TIET_HUY_HAO_HUT (SoPhieuHuy, MaVatTu, SoLuongHaoHut, GiaTri)
          VALUES (?, ?, ?, ?)
        `).run(soPhieuHuy, maVatTu, actualLossQty, giaTriHaoHut);

        db.prepare(`
          UPDATE VAT_TU_NGUYEN_LIEU
          SET SoLuongTonHienTai = MAX(0, SoLuongTonHienTai - ?)
          WHERE MaVatTu = ?
        `).run(actualLossQty, maVatTu);

        db.exec('COMMIT;');
      } catch (txErr) {
        db.exec('ROLLBACK;');
        throw txErr;
      }

      res.json({ 
        success: true, 
        message: `Đã ghi nhận hao hụt ${actualLossQty} ${mat.DonViTinh} ${mat.TenVatTu}!`,
        data: { soPhieuHuy, giaTriHaoHut }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
