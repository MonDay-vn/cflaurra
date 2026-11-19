import { Request, Response } from 'express';
import { ShiftService } from '../services/shiftService.js';
import { db } from '../db/database.js';

export class ShiftController {
  public static getCurrentShift(req: Request, res: Response) {
    try {
      const shift = ShiftService.getCurrentShift();
      res.json({ success: true, data: shift });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static openShift(req: Request, res: Response) {
    try {
      const { maCa, maNhanVien, tienDauCa, ghiChu } = req.body;
      const result = ShiftService.openShift(maCa || 'CA_SANG', maNhanVien || 'NV03', Number(tienDauCa || 0), ghiChu);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static closeShift(req: Request, res: Response) {
    try {
      const { maGiaoCa, tienMatThucTe, ghiChu } = req.body;
      const result = ShiftService.closeShift(maGiaoCa, Number(tienMatThucTe), ghiChu);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static approveShift(req: Request, res: Response) {
    try {
      const { maGiaoCa, maNguoiXacNhan } = req.body;
      const result = ShiftService.approveShift(maGiaoCa, maNguoiXacNhan || 'NV02');
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static getShiftHistory(req: Request, res: Response) {
    try {
      const history = ShiftService.getShiftHistory();
      res.json({ success: true, data: history });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static getLastClosedShift(req: Request, res: Response) {
    try {
      const last = ShiftService.getLastClosedShift();
      res.json({ success: true, data: last });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static getShiftConfigs(req: Request, res: Response) {
    try {
      const list = ShiftService.getShiftConfigs();
      res.json({ success: true, data: list });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static createShiftConfig(req: Request, res: Response) {
    try {
      const { maCa, tenCa, gioBatDau, gioKetThuc, tienCongTheoCa } = req.body;
      const result = ShiftService.createShiftConfig(maCa, tenCa, gioBatDau, gioKetThuc, tienCongTheoCa);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static updateShiftConfig(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { tenCa, gioBatDau, gioKetThuc, tienCongTheoCa } = req.body;
      const result = ShiftService.updateShiftConfig(id, tenCa, gioBatDau, gioKetThuc, tienCongTheoCa);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  public static deleteShiftConfig(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = ShiftService.deleteShiftConfig(id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  // --- LỊCH LÀM VIỆC / PHÂN CA CHO QUẢN LÝ VÀ NHÂN VIÊN ---
  public static getShiftSchedule(req: Request, res: Response) {
    try {
      const { fromDate, toDate } = req.query;

      let sql = `
        SELECT l.MaPhanCa, l.MaNhanVien, n.HoTen, n.SoDienThoai, t.VaiTro,
               l.MaCa, c.TenCa, c.GioBatDau, c.GioKetThuc, c.TienCongTheoCa,
               l.NgayLamViec, l.GhiChu, l.NguoiPhanCa
        FROM LICH_PHAN_CA l
        JOIN NHAN_VIEN n ON l.MaNhanVien = n.MaNhanVien
        JOIN CA_LAM_VIEC c ON l.MaCa = c.MaCa
        LEFT JOIN TAI_KHOAN t ON n.MaNhanVien = t.MaNhanVien
      `;

      const params: any[] = [];
      if (fromDate && toDate) {
        sql += ` WHERE l.NgayLamViec BETWEEN ? AND ?`;
        params.push(fromDate, toDate);
      }

      sql += ` ORDER BY l.NgayLamViec ASC, c.GioBatDau ASC, n.HoTen ASC`;

      const schedules = db.prepare(sql).all(...params);
      res.json({ success: true, data: schedules });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static assignShiftSchedule(req: Request, res: Response) {
    try {
      const { maNhanVien, maCa, ngayLamViec, ghiChu = '' } = req.body;
      const nguoiPhanCa = (req as any).user?.maNhanVien || 'NV01';

      if (!maNhanVien || !maCa || !ngayLamViec) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn nhân viên, ca làm và ngày làm việc' });
      }

      const maPhanCa = `LPC_${Date.now()}`;
      db.prepare(`
        INSERT INTO LICH_PHAN_CA (MaPhanCa, MaNhanVien, MaCa, NgayLamViec, GhiChu, NguoiPhanCa)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(maPhanCa, maNhanVien, maCa, ngayLamViec, ghiChu, nguoiPhanCa);

      res.status(201).json({ success: true, message: 'Đã xếp ca làm việc thành công!', data: { maPhanCa } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  public static deleteShiftSchedule(req: Request, res: Response) {
    try {
      const { id } = req.params;
      db.prepare('DELETE FROM LICH_PHAN_CA WHERE MaPhanCa = ?').run(id);
      res.json({ success: true, message: 'Đã xóa ca phân công làm việc thành công!' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
