import { db } from '../db/database.js';
import { CreateOrderDTO, LowStockAlert, KitchenStatus } from '../types/index.js';
import { kdsHub } from '../sockets/kdsHub.js';

export class OrderService {
  // Lưu lịch sử request gần nhất để chống Double-Submit / Race Condition
  private static recentSubmissions = new Map<string, { timestamp: number; result: any }>();

  /**
   * Tạo đơn hàng mới & gửi bếp KDS (Hỗ trợ gọi thêm Add-on & Chống trùng lặp)
   */
  public static createOrder(dto: CreateOrderDTO) {
    if (!dto.items || !Array.isArray(dto.items)) {
      throw new Error('Danh sách món gửi bếp không hợp lệ!');
    }
    const validItems = dto.items.filter(item => Number(item.soLuong) > 0);
    if (validItems.length === 0) {
      throw new Error('Không có món nào có số lượng hợp lệ để gửi bếp!');
    }

    // Chống Double Submit / Race condition trong 2.5s
    const itemSig = validItems
      .map(i => `${i.maMon}:${i.soLuong}:${(i.ghiChuTopping || '').trim()}`)
      .sort()
      .join('|');
    const idempotencyKey = `${dto.soHoaDon || dto.maBan || 'MD'}_${itemSig}`;
    const now = Date.now();
    const cachedSub = OrderService.recentSubmissions.get(idempotencyKey);
    if (cachedSub && (now - cachedSub.timestamp) < 2500) {
      console.warn(`[OrderService] Chặn duplicate submit trong 2.5s: ${idempotencyKey}`);
      return cachedSub.result;
    }

    // Dọn dẹp cache cũ
    if (OrderService.recentSubmissions.size > 200) {
      const cutoff = now - 10000;
      for (const [k, v] of OrderService.recentSubmissions.entries()) {
        if (v.timestamp < cutoff) OrderService.recentSubmissions.delete(k);
      }
    }

    // Kiểm tra xem bàn/đơn này đã có hóa đơn chờ thanh toán chưa (Xử lý Add-on / Gọi thêm)
    let existingOrder: any = null;
    if (dto.soHoaDon) {
      existingOrder = db.prepare("SELECT * FROM HOA_DON_BAN_HANG WHERE SoHoaDon = ? AND TrangThaiThanhToan = 'ChoThanhToan'").get(dto.soHoaDon) as any;
    }
    if (!existingOrder && dto.maBan) {
      existingOrder = db.prepare("SELECT * FROM HOA_DON_BAN_HANG WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan' ORDER BY NgayGioLap DESC LIMIT 1").get(dto.maBan) as any;
    }

    const ngayGioLap = new Date().toISOString();

    const ensureMenuItem = (item: any) => {
      let mon = db.prepare('SELECT TenMon FROM DANH_MUC_MON WHERE MaMon = ?').get(item.maMon) as any;
      if (!mon) {
        db.prepare(`
          INSERT OR IGNORE INTO NHOM_MON (MaNhom, TenNhom, ThuTuHienThi)
          VALUES ('GRP_CUSTOM', 'Món Tùy Chỉnh / Món Mới', 99)
        `).run();

        const customName = (item as any).tenMon || item.maMon;
        db.prepare(`
          INSERT OR IGNORE INTO DANH_MUC_MON (MaMon, TenMon, MaNhom, DonViTinh, GiaBanHienHanh, DangKinhDoanh)
          VALUES (?, ?, 'GRP_CUSTOM', 'Phần', ?, 1)
        `).run(item.maMon, customName, item.donGia);

        mon = { TenMon: customName };
      }
      return mon;
    };

    // =========================================================================
    // TRƯỜNG HỢP 1: GỌI THÊM MÓN (ADD-ON) CHO BÀN / HÓA ĐƠN ĐANG PHỤC VỤ
    // =========================================================================
    if (existingOrder) {
      const soHoaDon = existingOrder.SoHoaDon;
      const maxLanGoiRow = db.prepare("SELECT COALESCE(MAX(LanGoi), 1) as maxLan FROM CHI_TIET_HOA_DON WHERE SoHoaDon = ?").get(soHoaDon) as any;
      const lanGoi = (maxLanGoiRow?.maxLan || 1) + 1;

      let tongTienThem = 0;
      validItems.forEach(i => {
        tongTienThem += Number(i.donGia) * Number(i.soLuong);
      });

      const tongMoi = (existingOrder.TongTienMon || 0) + tongTienThem;
      const giamGia = existingOrder.GiamGia || 0;
      const tienMatThucThu = Math.max(0, tongMoi - giamGia);

      db.exec('BEGIN TRANSACTION;');
      try {
        // Cập nhật tổng tiền trên hóa đơn gốc để hóa đơn thanh toán luôn đầy đủ
        db.prepare(`
          UPDATE HOA_DON_BAN_HANG
          SET TongTienMon = ?, TienMatThucThu = ?
          WHERE SoHoaDon = ?
        `).run(tongMoi, tienMatThucThu, soHoaDon);

        // Lưu DUY NHẤT các món mới gọi thêm vào CHI_TIET_HOA_DON với LanGoi tương ứng
        const insertCT = db.prepare(`
          INSERT INTO CHI_TIET_HOA_DON (
            SoHoaDon, MaMon, SoLuong, DonGia, ThanhTien, GhiChuTopping, TrangThaiPhaChe, ThoiGianGuiBep, LanGoi
          ) VALUES (?, ?, ?, ?, ?, ?, 'ChoLam', ?, ?)
        `);

        const insertedItems: any[] = [];
        for (const item of validItems) {
          const mon = ensureMenuItem(item);
          const thanhTien = Number(item.soLuong) * Number(item.donGia);
          const note = (item.ghiChuTopping || '').trim();

          const insertRes = insertCT.run(
            soHoaDon,
            item.maMon,
            item.soLuong,
            item.donGia,
            thanhTien,
            note || null,
            ngayGioLap,
            lanGoi
          );

          insertedItems.push({
            maChiTiet: Number(insertRes.lastInsertRowid),
            maMon: item.maMon,
            tenMon: mon ? mon.TenMon : item.maMon,
            soLuong: item.soLuong,
            donGia: item.donGia,
            thanhTien,
            ghiChuTopping: note,
            trangThaiPhaChe: 'ChoLam',
            lanGoi,
            thoiGianGuiBep: ngayGioLap
          });
        }

        db.exec('COMMIT;');

        const ban = existingOrder.MaBan ? db.prepare('SELECT TenBan FROM BAN WHERE MaBan = ?').get(existingOrder.MaBan) as any : null;
        const tenBan = ban?.TenBan || (existingOrder.MaBan ? `Bàn ${existingOrder.MaBan}` : 'Đơn Mang Đi');

        // Đóng gói DUY NHẤT danh sách món mới/số lượng tăng thêm này thành Ticket KDS
        const addOnTicketPayload = {
          soHoaDon,
          ticketId: `${soHoaDon}_L${lanGoi}`,
          lanGoi,
          isAddOn: true,
          ngayGioLap,
          created_at: ngayGioLap,
          thoiGianGuiBep: ngayGioLap,
          kenhDatHang: existingOrder.KenhDatHang,
          maBan: existingOrder.MaBan,
          tenBan,
          tongTienMon: tongMoi,
          tienMatThucThu,
          phuongThucThanhToan: existingOrder.PhuongThucThanhToan,
          trangThaiThanhToan: existingOrder.TrangThaiThanhToan,
          items: insertedItems // CHỈ CHỨA CÁC MÓN GỌI THÊM!
        };

        kdsHub.broadcast('ORDER_NEW', addOnTicketPayload);
        kdsHub.broadcast('ORDER_UPDATED', { soHoaDon, maBan: existingOrder.MaBan });

        const result = {
          success: true,
          isAddOn: true,
          lanGoi,
          data: addOnTicketPayload,
          lowStockAlerts: []
        };

        OrderService.recentSubmissions.set(idempotencyKey, { timestamp: now, result });
        return result;
      } catch (err: any) {
        db.exec('ROLLBACK;');
        console.error('[OrderService.createOrder AddOn Error]:', err);
        throw new Error(`Gửi thêm món thất bại: ${err.message}`);
      }
    }

    // =========================================================================
    // TRƯỜNG HỢP 2: TẠO MỚI ĐƠN HÀNG LẦN ĐẦU
    // =========================================================================
    const soHoaDon = dto.soHoaDon || `HD_${Date.now()}`;
    let tongTienMon = 0;
    validItems.forEach(item => {
      tongTienMon += Number(item.donGia) * Number(item.soLuong);
    });

    let maKhachHang = dto.maKhachHang || null;
    let giamGia = dto.giamGia || 0;

    if (dto.soDienThoaiKhach && !maKhachHang) {
      const khach = db.prepare('SELECT MaKhachHang, HangThanhVien, DiemTichLuy FROM KHACH_HANG WHERE SoDienThoai = ?')
        .get(dto.soDienThoaiKhach) as any;
      if (khach) {
        maKhachHang = khach.MaKhachHang;
        if (!dto.giamGia) {
          if (khach.HangThanhVien === 'VIP') giamGia = tongTienMon * 0.15;
          else if (khach.HangThanhVien === 'Gold') giamGia = tongTienMon * 0.10;
          else if (khach.HangThanhVien === 'Silver') giamGia = tongTienMon * 0.05;
        }
      }
    }

    const tienMatThucThu = Math.max(0, tongTienMon - giamGia);
    const trangThaiThanhToan = dto.thanhToanNgay ? 'DaThanhToan' : 'ChoThanhToan';

    const caHienTai = db.prepare("SELECT MaCa, MaGiaoCa FROM BANG_KE_GIAO_CA WHERE TrangThai = 'DangMo' ORDER BY ThoiGianMoCa DESC LIMIT 1").get() as any;
    const maCa = caHienTai ? caHienTai.MaCa : null;

    db.exec('BEGIN TRANSACTION;');
    try {
      const insertHD = db.prepare(`
        INSERT INTO HOA_DON_BAN_HANG (
          SoHoaDon, NgayGioLap, KenhDatHang, MaBan, MaNhanVien, MaKhachHang,
          TongTienMon, GiamGia, TienMatThucThu, PhuongThucThanhToan,
          TrangThaiThanhToan, MaCa, GhiChu, OfflineId, DaDongBo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);

      insertHD.run(
        soHoaDon,
        ngayGioLap,
        dto.kenhDatHang || 'TaiBan',
        dto.maBan || null,
        dto.maNhanVien || 'NV03',
        maKhachHang || null,
        tongTienMon || 0,
        giamGia || 0,
        tienMatThucThu || 0,
        dto.phuongThucThanhToan || 'TienMat',
        trangThaiThanhToan,
        maCa || null,
        dto.ghiChu || null,
        dto.offlineId || null
      );

      const insertCT = db.prepare(`
        INSERT INTO CHI_TIET_HOA_DON (
          SoHoaDon, MaMon, SoLuong, DonGia, ThanhTien, GhiChuTopping, TrangThaiPhaChe, ThoiGianGuiBep, LanGoi
        ) VALUES (?, ?, ?, ?, ?, ?, 'ChoLam', ?, 1)
      `);

      const insertedItems: any[] = [];
      for (const item of validItems) {
        const mon = ensureMenuItem(item);
        const thanhTien = Number(item.soLuong) * Number(item.donGia);
        const insertRes = insertCT.run(
          soHoaDon,
          item.maMon,
          item.soLuong,
          item.donGia,
          thanhTien,
          item.ghiChuTopping || null,
          ngayGioLap
        );

        insertedItems.push({
          maChiTiet: Number(insertRes.lastInsertRowid),
          maMon: item.maMon,
          tenMon: mon ? mon.TenMon : item.maMon,
          soLuong: item.soLuong,
          donGia: item.donGia,
          thanhTien,
          ghiChuTopping: item.ghiChuTopping || '',
          trangThaiPhaChe: 'ChoLam',
          lanGoi: 1,
          thoiGianGuiBep: ngayGioLap
        });
      }

      if (dto.maBan) {
        db.prepare("UPDATE BAN SET TrangThai = 'CoKhach' WHERE MaBan = ?").run(dto.maBan);
      }

      let lowStockAlerts: LowStockAlert[] = [];
      if (dto.thanhToanNgay) {
        lowStockAlerts = OrderService.deductInventoryForOrder(soHoaDon);
        if (maKhachHang) {
          OrderService.accumulatePoints(maKhachHang, tienMatThucThu);
        }
        OrderService.recordCashRevenueInShift(caHienTai?.MaGiaoCa, dto.phuongThucThanhToan, tienMatThucThu);
      }

      db.exec('COMMIT;');

      const ban = dto.maBan ? db.prepare('SELECT TenBan FROM BAN WHERE MaBan = ?').get(dto.maBan) as any : null;
      const tenBan = ban?.TenBan || (dto.maBan ? `Bàn ${dto.maBan}` : 'Đơn Mang Đi');

      const orderPayload = {
        soHoaDon,
        ticketId: `${soHoaDon}_L1`,
        lanGoi: 1,
        isAddOn: false,
        ngayGioLap,
        created_at: ngayGioLap,
        thoiGianGuiBep: ngayGioLap,
        kenhDatHang: dto.kenhDatHang,
        maBan: dto.maBan,
        tenBan,
        tongTienMon,
        giamGia,
        tienMatThucThu,
        phuongThucThanhToan: dto.phuongThucThanhToan,
        trangThaiThanhToan,
        items: insertedItems
      };

      kdsHub.broadcast('ORDER_NEW', orderPayload);

      if (dto.maBan) {
        kdsHub.broadcast('TABLE_UPDATED', { maBan: dto.maBan, trangThai: 'CoKhach' });
      }

      if (lowStockAlerts.length > 0) {
        lowStockAlerts.forEach(alert => {
          kdsHub.broadcast('STOCK_ALERT', alert);
        });
      }

      const result = {
        success: true,
        isAddOn: false,
        lanGoi: 1,
        data: orderPayload,
        lowStockAlerts
      };

      OrderService.recentSubmissions.set(idempotencyKey, { timestamp: now, result });
      return result;
    } catch (err: any) {
      db.exec('ROLLBACK;');
      console.error('[OrderService.createOrder Error]:', err);
      throw new Error(`Tạo đơn hàng thất bại: ${err.message}`);
    }
  }

  /**
   * Xử lý thanh toán đơn hàng & trừ tồn kho tự động (Transaction Safe)
   */
  public static processPayment(soHoaDon: string, phuongThuc: string, maNhanVien: string) {
    const order = db.prepare('SELECT * FROM HOA_DON_BAN_HANG WHERE SoHoaDon = ?').get(soHoaDon) as any;
    if (!order) {
      throw new Error('Hóa đơn không tồn tại');
    }
    if (order.TrangThaiThanhToan === 'DaThanhToan') {
      throw new Error('Hóa đơn này đã được thanh toán trước đó');
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      // 1. Cập nhật hóa đơn
      db.prepare(`
        UPDATE HOA_DON_BAN_HANG
        SET TrangThaiThanhToan = 'DaThanhToan',
            PhuongThucThanhToan = ?,
            MaNhanVien = ?
        WHERE SoHoaDon = ?
      `).run(phuongThuc, maNhanVien, soHoaDon);

      // 2. Chạy thuật toán trừ tồn kho tự động (Recipe Auto-Deduction)
      const lowStockAlerts = OrderService.deductInventoryForOrder(soHoaDon);

      // 3. Tích điểm cho khách hàng
      if (order.MaKhachHang) {
        OrderService.accumulatePoints(order.MaKhachHang, order.TienMatThucThu);
      }

      // 4. Giải phóng bàn nếu không còn order đang chờ
      if (order.MaBan) {
        const remainingOrders = db.prepare(`
          SELECT COUNT(*) as cnt FROM HOA_DON_BAN_HANG
          WHERE MaBan = ? AND TrangThaiThanhToan = 'ChoThanhToan' AND SoHoaDon != ?
        `).get(order.MaBan, soHoaDon) as any;

        if (remainingOrders.cnt === 0) {
          db.prepare("UPDATE BAN SET TrangThai = 'Trong' WHERE MaBan = ?").run(order.MaBan);
        }
      }

      // 5. Ghi nhận doanh thu vào ca làm việc hiện tại
      const caHienTai = db.prepare("SELECT MaGiaoCa FROM BANG_KE_GIAO_CA WHERE TrangThai = 'DangMo' ORDER BY ThoiGianMoCa DESC LIMIT 1").get() as any;
      if (caHienTai) {
        OrderService.recordCashRevenueInShift(caHienTai.MaGiaoCa, phuongThuc, order.TienMatThucThu);
      }

      // 6. Ghi nhận vào Sổ quỹ thu chi nếu là Tiền mặt
      db.prepare(`
        INSERT INTO SO_QUY_THU_CHI (MaPhieuThuChi, LoaiPhieu, NgayPhatSinh, SoTien, MaNhanVien, DoiTuongNopNhan, ChungTuGoc, LyDo)
        VALUES (?, 'Thu', datetime('now'), ?, ?, ?, ?, ?)
      `).run(
        `PT_${Date.now()}`,
        order.TienMatThucThu,
        maNhanVien,
        order.MaKhachHang || 'Khách Vãng Lai',
        soHoaDon,
        `Thu tiền hóa đơn ${soHoaDon} qua ${phuongThuc}`
      );

      db.exec('COMMIT;');

      // Phát thông báo WebSocket
      if (order.MaBan) {
        kdsHub.broadcast('TABLE_UPDATED', { maBan: order.MaBan, trangThai: 'Trong' });
      }

      if (lowStockAlerts.length > 0) {
        lowStockAlerts.forEach(alert => kdsHub.broadcast('STOCK_ALERT', alert));
      }

      return {
        success: true,
        message: 'Thanh toán và trừ tồn kho hoàn tất',
        lowStockAlerts
      };
    } catch (err: any) {
      db.exec('ROLLBACK;');
      console.error('[OrderService.processPayment Error]:', err);
      throw new Error(`Xử lý thanh toán thất bại: ${err.message}`);
    }
  }

  /**
   * Thuật toán trừ tồn kho tự động theo công thức món (Recipe Mapping & Auto-Deduction)
   */
  private static deductInventoryForOrder(soHoaDon: string): LowStockAlert[] {
    const alerts: LowStockAlert[] = [];

    // Lấy chi tiết món
    const items = db.prepare('SELECT MaMon, SoLuong FROM CHI_TIET_HOA_DON WHERE SoHoaDon = ?').all(soHoaDon) as any[];

    for (const item of items) {
      // Tìm công thức món tương ứng
      const recipes = db.prepare(`
        SELECT c.MaVatTu, c.SoLuongDinhMuc, v.TenVatTu, v.SoLuongTonHienTai, v.MucToiThieuCanCanhBao, v.DonViTinh
        FROM CONG_THUC_MON c
        JOIN VAT_TU_NGUYEN_LIEU v ON c.MaVatTu = v.MaVatTu
        WHERE c.MaMon = ?
      `).all(item.MaMon) as any[];

      for (const r of recipes) {
        const luongHaoPhi = r.SoLuongDinhMuc * item.SoLuong;
        const soLuongTonMoi = r.SoLuongTonHienTai - luongHaoPhi;

        // Cập nhật trừ tồn kho
        db.prepare(`
          UPDATE VAT_TU_NGUYEN_LIEU
          SET SoLuongTonHienTai = ?
          WHERE MaVatTu = ?
        `).run(soLuongTonMoi, r.MaVatTu);

        // Kiểm tra ngưỡng cảnh báo chạm đáy tồn kho (Low Stock Warning)
        if (soLuongTonMoi <= r.MucToiThieuCanCanhBao) {
          alerts.push({
            maVatTu: r.MaVatTu,
            tenVatTu: r.TenVatTu,
            soLuongTonHienTai: Number(soLuongTonMoi.toFixed(2)),
            mucToiThieuCanCanhBao: r.MucToiThieuCanCanhBao,
            donViTinh: r.DonViTinh,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    return alerts;
  }

  /**
   * Tích điểm & Nâng hạng thành viên (10.000đ = 1 điểm)
   */
  private static accumulatePoints(maKhachHang: string, soTien: number) {
    const pointsEarned = Math.floor(soTien / 10000);
    if (pointsEarned <= 0) return;

    const kh = db.prepare('SELECT DiemTichLuy FROM KHACH_HANG WHERE MaKhachHang = ?').get(maKhachHang) as any;
    if (!kh) return;

    const newPoints = kh.DiemTichLuy + pointsEarned;
    let newTier = 'Member';
    if (newPoints >= 1000) newTier = 'VIP';
    else if (newPoints >= 500) newTier = 'Gold';
    else if (newPoints >= 100) newTier = 'Silver';

    db.prepare(`
      UPDATE KHACH_HANG
      SET DiemTichLuy = ?,
          HangThanhVien = ?
      WHERE MaKhachHang = ?
    `).run(newPoints, newTier, maKhachHang);
  }

  /**
   * Cập nhật doanh thu vào ca làm việc hiện hành
   */
  private static recordCashRevenueInShift(maGiaoCa: string | undefined, phuongThuc: string, soTien: number) {
    if (!maGiaoCa) return;

    if (phuongThuc === 'TienMat') {
      db.prepare(`
        UPDATE BANG_KE_GIAO_CA
        SET DoanhThuTienMat = DoanhThuTienMat + ?
        WHERE MaGiaoCa = ?
      `).run(soTien, maGiaoCa);
    } else {
      db.prepare(`
        UPDATE BANG_KE_GIAO_CA
        SET DoanhThuChuyenKhoan = DoanhThuChuyenKhoan + ?
        WHERE MaGiaoCa = ?
      `).run(soTien, maGiaoCa);
    }
  }

  /**
   * Cập nhật trạng thái pha chế KDS (ChoLam -> DangLam -> HoanThanh)
   */
  public static updateKdsItemStatus(maChiTiet: number, trangThai: KitchenStatus) {
    const ct = db.prepare('SELECT SoHoaDon, MaMon FROM CHI_TIET_HOA_DON WHERE MaChiTiet = ?').get(maChiTiet) as any;
    if (!ct) {
      throw new Error('Món không tồn tại trong chi tiết hóa đơn');
    }

    const thoiGianHoanThanh = trangThai === 'HoanThanh' ? new Date().toISOString() : null;

    db.prepare(`
      UPDATE CHI_TIET_HOA_DON
      SET TrangThaiPhaChe = ?,
          ThoiGianHoanThanh = COALESCE(?, ThoiGianHoanThanh)
      WHERE MaChiTiet = ?
    `).run(trangThai, thoiGianHoanThanh, maChiTiet);

    // Phát broadcast cập nhật item
    kdsHub.broadcast('KDS_ITEM_STATUS', {
      maChiTiet,
      soHoaDon: ct.SoHoaDon,
      trangThai
    });

    // Kiểm tra xem tất cả các món trong đơn hàng đã hoàn tất chưa
    const remainingUnfinished = db.prepare(`
      SELECT COUNT(*) as count FROM CHI_TIET_HOA_DON
      WHERE SoHoaDon = ? AND TrangThaiPhaChe != 'HoanThanh'
    `).get(ct.SoHoaDon) as any;

    if (remainingUnfinished.count === 0) {
      // Đơn hàng đã làm xong hoàn toàn -> thông báo phục vụ / thu ngân
      const order = db.prepare('SELECT MaBan, KenhDatHang FROM HOA_DON_BAN_HANG WHERE SoHoaDon = ?').get(ct.SoHoaDon) as any;
      kdsHub.broadcast('KDS_ORDER_COMPLETED', {
        soHoaDon: ct.SoHoaDon,
        maBan: order?.MaBan,
        kenhDatHang: order?.KenhDatHang,
        message: `Đơn hàng ${ct.SoHoaDon} (${order?.MaBan || 'Mang đi'}) đã hoàn tất pha chế!`
      });
    }

    return { success: true, maChiTiet, trangThai };
  }

  /**
   * Cập nhật hàng loạt món pha chế (Batch mode: làm gộp nhiều ly cùng lúc)
   */
  public static updateKdsBatchStatus(itemIds: number[], trangThai: KitchenStatus) {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0 };
    }

    const thoiGianHoanThanh = trangThai === 'HoanThanh' ? new Date().toISOString() : null;
    const placeholders = itemIds.map(() => '?').join(',');

    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare(`
        UPDATE CHI_TIET_HOA_DON
        SET TrangThaiPhaChe = ?,
            ThoiGianHoanThanh = COALESCE(?, ThoiGianHoanThanh)
        WHERE MaChiTiet IN (${placeholders})
      `).run(trangThai, thoiGianHoanThanh, ...itemIds);

      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }

    kdsHub.broadcast('KDS_RELOAD_NEEDED', { itemIds, trangThai });
    return { success: true, count: itemIds.length, trangThai };
  }

  /**
   * Hoàn tất đơn hàng hoặc đợt gọi món KDS chỉ với 1 click
   */
  public static completeEntireOrder(soHoaDon: string, lanGoi?: number) {
    const thoiGianHoanThanh = new Date().toISOString();
    const hasLanGoi = lanGoi !== undefined && lanGoi !== null && !isNaN(Number(lanGoi));

    if (hasLanGoi) {
      db.prepare(`
        UPDATE CHI_TIET_HOA_DON
        SET TrangThaiPhaChe = 'HoanThanh',
            ThoiGianHoanThanh = ?
        WHERE SoHoaDon = ? AND COALESCE(LanGoi, 1) = ?
      `).run(thoiGianHoanThanh, soHoaDon, Number(lanGoi));
    } else {
      db.prepare(`
        UPDATE CHI_TIET_HOA_DON
        SET TrangThaiPhaChe = 'HoanThanh',
            ThoiGianHoanThanh = ?
        WHERE SoHoaDon = ?
      `).run(thoiGianHoanThanh, soHoaDon);
    }

    const order = db.prepare('SELECT MaBan, KenhDatHang FROM HOA_DON_BAN_HANG WHERE SoHoaDon = ?').get(soHoaDon) as any;

    // Kiểm tra xem đơn hàng đã hoàn tất toàn bộ các đợt chưa
    const remaining = db.prepare(`
      SELECT COUNT(*) as count FROM CHI_TIET_HOA_DON
      WHERE SoHoaDon = ? AND TrangThaiPhaChe != 'HoanThanh'
    `).get(soHoaDon) as any;

    if (remaining.count === 0) {
      kdsHub.broadcast('KDS_ORDER_COMPLETED', {
        soHoaDon,
        lanGoi,
        maBan: order?.MaBan,
        kenhDatHang: order?.KenhDatHang,
        message: `Đơn hàng ${soHoaDon} (${order?.MaBan || 'Mang đi'}) đã hoàn tất toàn bộ pha chế!`
      });
    }

    kdsHub.broadcast('KDS_RELOAD_NEEDED', { soHoaDon, lanGoi });

    return { success: true, soHoaDon, lanGoi };
  }

  /**
   * Lấy danh sách phiếu order chờ pha chế trên KDS
   * Mỗi đợt gọi món (LanGoi) tách thành 1 phiếu KDS riêng biệt để không gửi lại món cũ
   */
  public static getActiveKdsTickets() {
    const rounds = db.prepare(`
      SELECT hd.SoHoaDon, hd.NgayGioLap, hd.KenhDatHang, hd.MaBan, b.TenBan, hd.GhiChu,
             COALESCE(ct.LanGoi, 1) AS LanGoi,
             MIN(ct.ThoiGianGuiBep) AS ThoiGianGuiBepRound
      FROM HOA_DON_BAN_HANG hd
      JOIN CHI_TIET_HOA_DON ct ON hd.SoHoaDon = ct.SoHoaDon
      LEFT JOIN BAN b ON hd.MaBan = b.MaBan
      WHERE ct.TrangThaiPhaChe != 'HoanThanh'
      GROUP BY hd.SoHoaDon, COALESCE(ct.LanGoi, 1)
      ORDER BY ThoiGianGuiBepRound ASC, hd.NgayGioLap ASC
    `).all() as any[];

    const result = rounds.map(r => {
      const items = db.prepare(`
        SELECT ct.MaChiTiet, ct.MaMon, m.TenMon, ct.SoLuong, ct.GhiChuTopping,
               ct.TrangThaiPhaChe, ct.ThoiGianGuiBep, COALESCE(ct.LanGoi, 1) AS LanGoi
        FROM CHI_TIET_HOA_DON ct
        JOIN DANH_MUC_MON m ON ct.MaMon = m.MaMon
        WHERE ct.SoHoaDon = ? AND COALESCE(ct.LanGoi, 1) = ?
        ORDER BY ct.MaChiTiet ASC
      `).all(r.SoHoaDon, r.LanGoi) as any[];

      return {
        ...r,
        ticketId: `${r.SoHoaDon}_L${r.LanGoi}`,
        lanGoi: r.LanGoi,
        isAddOn: r.LanGoi > 1,
        created_at: r.ThoiGianGuiBepRound || r.NgayGioLap,
        thoiGianGuiBep: r.ThoiGianGuiBepRound || r.NgayGioLap,
        items
      };
    });

    return result;
  }

  public static approveCancelItem(dto: {
    soHoaDon?: string;
    maChiTiet?: number;
    tenMon: string;
    soLuong: number;
    donGia: number;
    lyDoHuy: string;
    nguoiYeuCau: string;
    nguoiPheDuyet: string;
    vaiTroPheDuyet: string;
  }) {
    const maYeuCau = `YC_${Date.now()}`;
    const thanhTienHuy = (Number(dto.soLuong) || 1) * (Number(dto.donGia) || 0);

    // 1. Lưu bản ghi phê duyệt hủy món vào YEU_CAU_HUY_DOI_MON (Kiểm toán RBAC)
    db.prepare(`
      INSERT INTO YEU_CAU_HUY_DOI_MON (
        MaYeuCau, SoHoaDon, MaChiTiet, TenMon, SoLuong, DonGia, ThanhTienHuy,
        LyDoHuy, NguoiYeuCau, NguoiPheDuyet, VaiTroPheDuyet, ThoiGianYeuCau, ThoiGianDuyet, TrangThaiDuyet
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'DaDuyet')
    `).run(
      maYeuCau,
      dto.soHoaDon || null,
      dto.maChiTiet || null,
      dto.tenMon,
      Number(dto.soLuong) || 1,
      Number(dto.donGia) || 0,
      thanhTienHuy,
      dto.lyDoHuy || 'KhachDoiY',
      dto.nguoiYeuCau || 'NV03',
      dto.nguoiPheDuyet || 'NV02',
      dto.vaiTroPheDuyet || 'QuanLy'
    );

    // 2. Nếu hóa đơn đã tạo trong CSDL, xóa món và cập nhật lại doanh thu hóa đơn
    if (dto.soHoaDon) {
      const order = db.prepare('SELECT * FROM HOA_DON_BAN_HANG WHERE SoHoaDon = ?').get(dto.soHoaDon) as any;
      if (order) {
        if (dto.maChiTiet) {
          db.prepare('DELETE FROM CHI_TIET_HOA_DON WHERE MaChiTiet = ?').run(dto.maChiTiet);
        } else if (dto.tenMon) {
          const ct = db.prepare(`
            SELECT c.MaChiTiet FROM CHI_TIET_HOA_DON c
            JOIN DANH_MUC_MON m ON c.MaMon = m.MaMon
            WHERE c.SoHoaDon = ? AND m.TenMon = ?
            LIMIT 1
          `).get(dto.soHoaDon, dto.tenMon) as any;
          if (ct) {
            db.prepare('DELETE FROM CHI_TIET_HOA_DON WHERE MaChiTiet = ?').run(ct.MaChiTiet);
          }
        }

        // Tính lại tổng tiền món sau khi hủy
        const totals = db.prepare(`
          SELECT COALESCE(SUM(ThanhTien), 0) as TongTien FROM CHI_TIET_HOA_DON WHERE SoHoaDon = ?
        `).get(dto.soHoaDon) as any;

        const tongMoi = totals ? totals.TongTien : 0;
        const giamGia = order.GiamGia || 0;
        const thucThu = Math.max(0, tongMoi - giamGia);

        db.prepare(`
          UPDATE HOA_DON_BAN_HANG
          SET TongTienMon = ?, TienMatThucThu = ?
          WHERE SoHoaDon = ?
        `).run(tongMoi, thucThu, dto.soHoaDon);

        if (tongMoi === 0 && order.MaBan) {
          db.prepare("UPDATE BAN SET TrangThai = 'Trong' WHERE MaBan = ?").run(order.MaBan);
        }
      }
    }

    // 3. Bắn WebSocket thông báo KDS loại bỏ món đang chờ làm
    kdsHub.broadcast('ITEM_CANCELED', {
      maYeuCau,
      soHoaDon: dto.soHoaDon,
      tenMon: dto.tenMon,
      soLuong: dto.soLuong,
      nguoiPheDuyet: dto.nguoiPheDuyet,
      vaiTroPheDuyet: dto.vaiTroPheDuyet,
      lyDoHuy: dto.lyDoHuy
    });

    return {
      success: true,
      message: `Đã được phê duyệt hủy món "${dto.tenMon}" thành công!`,
      data: { maYeuCau, thanhTienHuy }
    };
  }

  public static getCancelHistory() {
    return db.prepare(`
      SELECT y.*, 
             nvYeuCau.HoTen as TenNguoiYeuCau,
             nvDuyet.HoTen as TenNguoiDuyet
      FROM YEU_CAU_HUY_DOI_MON y
      LEFT JOIN NHAN_VIEN nvYeuCau ON y.NguoiYeuCau = nvYeuCau.MaNhanVien
      LEFT JOIN NHAN_VIEN nvDuyet ON y.NguoiPheDuyet = nvDuyet.MaNhanVien
      ORDER BY y.ThoiGianDuyet DESC
      LIMIT 50
    `).all();
  }
}
