import { Request, Response } from 'express';
import { OrderService } from '../services/orderService.js';
import { PrinterService } from '../services/printerService.js';
import { db } from '../db/database.js';

export class OrderController {
  public static async createOrder(req: Request, res: Response) {
    try {
      const result = OrderService.createOrder(req.body);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async payOrder(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { phuongThucThanhToan, maNhanVien } = req.body;
      const result = OrderService.processPayment(id, phuongThucThanhToan || 'TienMat', maNhanVien || 'NV03');
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async getKdsTickets(req: Request, res: Response) {
    try {
      const tickets = OrderService.getActiveKdsTickets();
      res.json({ success: true, data: tickets });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static async updateKdsItemStatus(req: Request, res: Response) {
    try {
      const { itemId } = req.params;
      const { status } = req.body;
      const result = OrderService.updateKdsItemStatus(Number(itemId), status);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async updateKdsBatchStatus(req: Request, res: Response) {
    try {
      const itemIds = req.body.itemIds;
      const status = req.body.status || req.body.trangThai;
      if (!Array.isArray(itemIds) || !status) {
        return res.status(400).json({ success: false, message: 'Vui lòng cung cấp danh sách itemIds và trạng thái' });
      }
      const result = OrderService.updateKdsBatchStatus(itemIds.map(Number), status);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async completeEntireOrder(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const rawLanGoi = req.query.lanGoi ?? req.body?.lanGoi;
      const lanGoi = rawLanGoi !== undefined && rawLanGoi !== null ? Number(rawLanGoi) : undefined;
      const result = OrderService.completeEntireOrder(id, lanGoi);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async getReceipt(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const receipt = PrinterService.generateEscPosReceipt(id);
      res.json({
        success: true,
        data: {
          textContent: receipt.textContent,
          escPosBase64: receipt.buffer.toString('base64')
        }
      });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async getTableActiveOrder(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const order = db.prepare(`
        SELECT hd.*, b.TenBan, k.HoTen as TenKhachHang, k.DiemTichLuy, k.HangThanhVien
        FROM HOA_DON_BAN_HANG hd
        LEFT JOIN BAN b ON hd.MaBan = b.MaBan
        LEFT JOIN KHACH_HANG k ON hd.MaKhachHang = k.MaKhachHang
        WHERE hd.MaBan = ? AND hd.TrangThaiThanhToan = 'ChoThanhToan'
        ORDER BY hd.NgayGioLap DESC
        LIMIT 1
      `).get(id) as any;

      if (!order) {
        return res.json({ success: true, hasOrder: false, order: null, items: [] });
      }

      const items = db.prepare(`
        SELECT ct.*, m.TenMon, m.GiaBanHienHanh, m.HinhAnh
        FROM CHI_TIET_HOA_DON ct
        JOIN DANH_MUC_MON m ON ct.MaMon = m.MaMon
        WHERE ct.SoHoaDon = ?
      `).all(order.SoHoaDon);

      res.json({
        success: true,
        hasOrder: true,
        order,
        items
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Lấy lịch sử hóa đơn bán hàng (Xem lại bill cũ, lọc theo ngày/tìm kiếm, in lại hóa đơn)
   */
  public static async getOrderHistory(req: Request, res: Response) {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const search = (req.query.search as string || '').trim().toLowerCase();
      const date = (req.query.date as string || '').trim();

      let query = `
        SELECT hd.SoHoaDon, hd.NgayGioLap, hd.KenhDatHang, hd.MaBan, hd.TongTienMon, hd.GiamGia,
               hd.TienMatThucThu, hd.PhuongThucThanhToan, hd.TrangThaiThanhToan, hd.GhiChu,
               COALESCE(b.TenBan, 'Đơn Mang Đi') as TenBan,
               k.HoTen as TenKhachHang, nv.HoTen as TenNhanVien,
               (SELECT COUNT(*) FROM CHI_TIET_HOA_DON WHERE SoHoaDon = hd.SoHoaDon) as TongMon
        FROM HOA_DON_BAN_HANG hd
        LEFT JOIN BAN b ON hd.MaBan = b.MaBan
        LEFT JOIN KHACH_HANG k ON hd.MaKhachHang = k.MaKhachHang
        LEFT JOIN NHAN_VIEN nv ON hd.MaNhanVien = nv.MaNhanVien
        WHERE 1=1
      `;
      const params: any[] = [];

      if (date) {
        query += ` AND substr(hd.NgayGioLap, 1, 10) = ?`;
        params.push(date.slice(0, 10));
      }

      if (search) {
        query += ` AND (LOWER(hd.SoHoaDon) LIKE ? OR LOWER(COALESCE(b.TenBan, '')) LIKE ? OR LOWER(COALESCE(k.HoTen, '')) LIKE ? OR LOWER(COALESCE(nv.HoTen, '')) LIKE ?)`;
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }

      query += ` ORDER BY hd.NgayGioLap DESC LIMIT ?`;
      params.push(limit);

      const orders = db.prepare(query).all(...params);
      res.json({ success: true, data: orders });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static async getOrderById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const order = db.prepare(`
        SELECT hd.*, b.TenBan, k.HoTen as TenKhachHang
        FROM HOA_DON_BAN_HANG hd
        LEFT JOIN BAN b ON hd.MaBan = b.MaBan
        LEFT JOIN KHACH_HANG k ON hd.MaKhachHang = k.MaKhachHang
        WHERE hd.SoHoaDon = ?
      `).get(id) as any;

      if (!order) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
      }

      const items = db.prepare(`
        SELECT ct.*, m.TenMon, m.HinhAnh
        FROM CHI_TIET_HOA_DON ct
        JOIN DANH_MUC_MON m ON ct.MaMon = m.MaMon
        WHERE ct.SoHoaDon = ?
      `).all(id);

      res.json({ success: true, order, items });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Offline Reconciliation Worker endpoint
   * Đẩy danh sách các đơn hàng offline lên server khi có mạng lại
   */
  public static async reconcileOfflineOrders(req: Request, res: Response) {
    try {
      const { orders } = req.body as { orders: any[] };
      const syncedOrders: string[] = [];
      const failedOrders: any[] = [];

      for (const orderDto of orders) {
        try {
          const result = OrderService.createOrder({
            ...orderDto,
            thanhToanNgay: true
          });
          syncedOrders.push(result.data.soHoaDon);
        } catch (e: any) {
          failedOrders.push({ offlineId: orderDto.offlineId, error: e.message });
        }
      }

      res.json({
        success: true,
        message: `Đồng bộ hoàn tất ${syncedOrders.length} đơn hàng ngoại tuyến.`,
        syncedOrders,
        failedOrders
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static async cancelItem(req: Request, res: Response) {
    try {
      const { soHoaDon, maChiTiet, tenMon, soLuong, donGia, lyDoHuy, nguoiYeuCau, nguoiPheDuyet, vaiTroPheDuyet } = req.body;
      const result = OrderService.approveCancelItem({
        soHoaDon,
        maChiTiet,
        tenMon: tenMon || 'Món không tên',
        soLuong: Number(soLuong) || 1,
        donGia: Number(donGia) || 0,
        lyDoHuy: lyDoHuy || 'KhachDoiY',
        nguoiYeuCau: nguoiYeuCau || 'NV03',
        nguoiPheDuyet: nguoiPheDuyet || 'NV02',
        vaiTroPheDuyet: vaiTroPheDuyet || 'QuanLy'
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static async getCancelHistory(req: Request, res: Response) {
    try {
      const list = OrderService.getCancelHistory();
      res.json({ success: true, data: list });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
