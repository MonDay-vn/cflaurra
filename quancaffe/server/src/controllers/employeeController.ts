import { Request, Response } from 'express';
import { db } from '../db/database.js';

export class EmployeeController {
  /**
   * Lấy danh sách nhân viên cùng chức vụ, bộ phận, vai trò tài khoản
   */
  public static getEmployees(req: Request, res: Response) {
    try {
      const employees = db.prepare(`
        SELECT n.MaNhanVien, n.HoTen, n.SoDienThoai, n.NgaySinh, n.TrangThaiLamViec,
               c.MaChucVu, c.TenChucVu, b.MaBoPhan, b.TenBoPhan,
               t.VaiTro, t.TenDangNhap, t.KichHoat
        FROM NHAN_VIEN n
        LEFT JOIN CHUC_VU c ON n.MaChucVu = c.MaChucVu
        LEFT JOIN DON_VI_BO_PHAN b ON n.MaBoPhan = b.MaBoPhan
        LEFT JOIN TAI_KHOAN t ON n.MaNhanVien = t.MaNhanVien
        ORDER BY n.MaNhanVien ASC
      `).all();

      res.json({ success: true, data: employees });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Lấy danh mục chức vụ, bộ phận, ca làm việc để hiển thị form chọn
   */
  public static getMetadata(req: Request, res: Response) {
    try {
      const chucVuList = db.prepare('SELECT * FROM CHUC_VU ORDER BY HeSoLuong DESC').all();
      const boPhanList = db.prepare('SELECT * FROM DON_VI_BO_PHAN ORDER BY MaBoPhan ASC').all();
      const caLamViecList = db.prepare('SELECT * FROM CA_LAM_VIEC ORDER BY GioBatDau ASC').all();

      res.json({
        success: true,
        data: {
          chucVuList,
          boPhanList,
          caLamViecList,
          chucVu: chucVuList,
          boPhan: boPhanList,
          caLamViec: caLamViecList
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Thêm nhân viên mới
   */
  public static createEmployee(req: Request, res: Response) {
    try {
      const { hoTen, soDienThoai, ngaySinh, maChucVu, maBoPhan, vaiTro, viTri, tenDangNhap, matKhau = '123456' } = req.body;

      if (!hoTen || !hoTen.trim()) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập họ và tên nhân viên' });
      }

      const cleanPhone = (soDienThoai || '').toString().trim().replace(/\s+/g, '');
      if (!cleanPhone || cleanPhone.length < 9) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập số điện thoại hợp lệ (tối thiểu 9 số)' });
      }

      // Tự động phân bổ Chức vụ, Bộ phận, Vai trò dựa trên Vị trí công việc (hoặc fallback)
      let finalChucVu = maChucVu;
      let finalBoPhan = maBoPhan;
      let finalVaiTro = vaiTro || viTri || 'PhucVu';

      const roleMap: Record<string, { cv: string; bp: string; role: string }> = {
        'ChuQuan': { cv: 'CV_OWNER', bp: 'BP_QL', role: 'ChuQuan' },
        'QuanLy':  { cv: 'CV_MGR',   bp: 'BP_QL', role: 'QuanLy' },
        'ThuNgan': { cv: 'CV_CASHIER', bp: 'BP_TN', role: 'ThuNgan' },
        'PhaChe':  { cv: 'CV_BAR',   bp: 'BP_BAR', role: 'PhaChe' },
        'PhucVu':  { cv: 'CV_WAITER', bp: 'BP_PV', role: 'PhucVu' }
      };

      const mapped = roleMap[viTri || vaiTro || ''] || roleMap[finalVaiTro];
      if (mapped) {
        finalChucVu = finalChucVu || mapped.cv;
        finalBoPhan = finalBoPhan || mapped.bp;
        finalVaiTro = mapped.role;
      } else {
        finalChucVu = finalChucVu || 'CV_WAITER';
        finalBoPhan = finalBoPhan || 'BP_PV';
      }

      // Tự sinh mã nhân viên kế tiếp an toàn (dựa trên số lớn nhất hiện tại, không dùng COUNT)
      const maxRow = db.prepare(`
        SELECT COALESCE(MAX(CAST(SUBSTR(MaNhanVien, 3) AS INTEGER)), 0) as maxNum
        FROM NHAN_VIEN
        WHERE MaNhanVien LIKE 'NV%'
      `).get() as any;
      const nextNum = ((maxRow?.maxNum || 0) + 1).toString().padStart(2, '0');
      const maNhanVien = `NV${nextNum}`;

      // Tên đăng nhập mặc định: dùng Số điện thoại hoặc tên gợi ý
      const defaultUsername = tenDangNhap && tenDangNhap.trim()
        ? tenDangNhap.trim().toLowerCase()
        : cleanPhone;

      // Kiểm tra trùng username
      const existingUser = db.prepare('SELECT MaTaiKhoan FROM TAI_KHOAN WHERE TenDangNhap = ?').get(defaultUsername);
      if (existingUser) {
        return res.status(400).json({ success: false, message: `Tên đăng nhập/Số điện thoại '${defaultUsername}' đã được sử dụng. Vui lòng chọn tên đăng nhập khác.` });
      }

      // Kiểm tra trùng số điện thoại
      const existingPhone = db.prepare('SELECT MaNhanVien, HoTen FROM NHAN_VIEN WHERE SoDienThoai = ?').get(cleanPhone) as any;
      if (existingPhone) {
        return res.status(400).json({ success: false, message: `Số điện thoại ${cleanPhone} đã được đăng ký cho nhân viên ${existingPhone.HoTen} (${existingPhone.MaNhanVien}).` });
      }

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          INSERT INTO NHAN_VIEN (MaNhanVien, HoTen, NgaySinh, SoDienThoai, MaChucVu, MaBoPhan, TrangThaiLamViec)
          VALUES (?, ?, ?, ?, ?, ?, 'DangLamViec')
        `).run(maNhanVien, hoTen.trim(), ngaySinh || '2000-01-01', cleanPhone, finalChucVu, finalBoPhan);

        db.prepare(`
          INSERT INTO TAI_KHOAN (MaTaiKhoan, MaNhanVien, TenDangNhap, MatKhauHash, VaiTro, KichHoat)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(`TK_${maNhanVien}`, maNhanVien, defaultUsername, matKhau, finalVaiTro);

        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }

      res.status(201).json({
        success: true,
        message: `Đã thêm thành công nhân viên ${hoTen.trim()} (${maNhanVien})!`,
        data: { maNhanVien, hoTen: hoTen.trim(), vaiTro: finalVaiTro, tenDangNhap: defaultUsername }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Cập nhật thông tin nhân viên & vai trò RBAC
   */
  public static updateEmployee(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const {
        hoTen, soDienThoai, ngaySinh, maChucVu, maBoPhan,
        vaiTro, viTri, trangThaiLamViec, trangThaiHoatDong
      } = req.body;

      // Hỗ trợ cả 2 tên trường để đồng bộ tuyệt đối Frontend và Backend
      const finalStatus = trangThaiLamViec || trangThaiHoatDong;

      const emp = db.prepare('SELECT * FROM NHAN_VIEN WHERE MaNhanVien = ?').get(id) as any;
      if (!emp) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy nhân viên' });
      }

      // Map vai trò nếu có vị trí
      let finalChucVu = maChucVu;
      let finalBoPhan = maBoPhan;
      let finalVaiTro = vaiTro || viTri;

      const roleMap: Record<string, { cv: string; bp: string; role: string }> = {
        'ChuQuan': { cv: 'CV_OWNER', bp: 'BP_QL', role: 'ChuQuan' },
        'QuanLy':  { cv: 'CV_MGR',   bp: 'BP_QL', role: 'QuanLy' },
        'ThuNgan': { cv: 'CV_CASHIER', bp: 'BP_TN', role: 'ThuNgan' },
        'PhaChe':  { cv: 'CV_BAR',   bp: 'BP_BAR', role: 'PhaChe' },
        'PhucVu':  { cv: 'CV_WAITER', bp: 'BP_PV', role: 'PhucVu' }
      };

      if (finalVaiTro && roleMap[finalVaiTro]) {
        finalChucVu = finalChucVu || roleMap[finalVaiTro].cv;
        finalBoPhan = finalBoPhan || roleMap[finalVaiTro].bp;
      }

      if (finalStatus === 'NghiViec' && ((req as any).user?.maNhanVien === id || id === 'NV01')) {
        return res.status(400).json({ success: false, message: 'Không thể chuyển tài khoản Chủ Quán hoặc tài khoản đang đăng nhập sang trạng thái Nghỉ Việc!' });
      }

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          UPDATE NHAN_VIEN
          SET HoTen = COALESCE(?, HoTen),
              SoDienThoai = COALESCE(?, SoDienThoai),
              NgaySinh = COALESCE(?, NgaySinh),
              MaChucVu = COALESCE(?, MaChucVu),
              MaBoPhan = COALESCE(?, MaBoPhan),
              TrangThaiLamViec = COALESCE(?, TrangThaiLamViec)
          WHERE MaNhanVien = ?
        `).run(
          hoTen ? hoTen.trim() : null,
          soDienThoai ? soDienThoai.trim() : null,
          ngaySinh ?? null,
          finalChucVu ?? null,
          finalBoPhan ?? null,
          finalStatus ?? null,
          id
        );

        if (finalVaiTro) {
          db.prepare(`
            UPDATE TAI_KHOAN
            SET VaiTro = ?
            WHERE MaNhanVien = ?
          `).run(finalVaiTro, id);
        }

        // Tự động đồng bộ kích hoạt tài khoản theo trạng thái làm việc
        if (finalStatus === 'DangLamViec') {
          db.prepare('UPDATE TAI_KHOAN SET KichHoat = 1 WHERE MaNhanVien = ?').run(id);
        } else if (finalStatus === 'NghiViec') {
          db.prepare('UPDATE TAI_KHOAN SET KichHoat = 0 WHERE MaNhanVien = ?').run(id);
        }

        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }

      res.json({ success: true, message: 'Cập nhật hồ sơ nhân sự thành công!' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Xóa hoặc chuyển trạng thái nhân viên (Xóa an toàn)
   */
  public static deleteEmployee(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (id === 'NV01') {
        return res.status(400).json({ success: false, message: 'Không thể xóa tài khoản Chủ Quán (Root Admin)' });
      }

      const emp = db.prepare('SELECT * FROM NHAN_VIEN WHERE MaNhanVien = ?').get(id) as any;
      if (!emp) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy nhân viên' });
      }

      // Kiểm tra toàn diện ràng buộc dữ liệu: Hóa đơn, Giao ca, Chấm công, Phân ca
      const checkOrders = db.prepare('SELECT COUNT(*) as count FROM HOA_DON_BAN_HANG WHERE MaNhanVien = ?').get(id) as any;
      const checkShifts = db.prepare('SELECT COUNT(*) as count FROM BANG_KE_GIAO_CA WHERE MaNhanVien = ?').get(id) as any;
      const checkTimekeeping = db.prepare('SELECT COUNT(*) as count FROM CHAM_CONG_CA WHERE MaNhanVien = ?').get(id) as any;
      const checkSchedule = db.prepare('SELECT COUNT(*) as count FROM LICH_PHAN_CA WHERE MaNhanVien = ?').get(id) as any;

      const hasHistory = (checkOrders?.count > 0) || (checkShifts?.count > 0) || (checkTimekeeping?.count > 0) || (checkSchedule?.count > 0);

      if (hasHistory) {
        // Có dữ liệu liên quan -> Chuyển sang trạng thái Nghỉ Việc & Khóa tài khoản (Xóa mềm)
        db.prepare("UPDATE NHAN_VIEN SET TrangThaiLamViec = 'NghiViec' WHERE MaNhanVien = ?").run(id);
        db.prepare('UPDATE TAI_KHOAN SET KichHoat = 0 WHERE MaNhanVien = ?').run(id);
        return res.json({
          success: true,
          message: `Nhân viên ${emp.HoTen} đã phát sinh lịch sử giao dịch/chấm công nên được chuyển sang trạng thái 'Nghỉ Việc' và khóa tài khoản an toàn.`
        });
      }

      // Chưa phát sinh giao dịch nào -> Xóa vĩnh viễn an toàn
      if (finalStatus === 'NghiViec' && ((req as any).user?.maNhanVien === id || id === 'NV01')) {
        return res.status(400).json({ success: false, message: 'Không thể chuyển tài khoản Chủ Quán hoặc tài khoản đang đăng nhập sang trạng thái Nghỉ Việc!' });
      }

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare('DELETE FROM TAI_KHOAN WHERE MaNhanVien = ?').run(id);
        db.prepare('DELETE FROM NHAN_VIEN WHERE MaNhanVien = ?').run(id);
        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }

      res.json({ success: true, message: `Đã xóa nhân viên ${emp.HoTen} khỏi hệ thống.` });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Lấy lịch sử chấm ca làm việc
   */
  public static getTimekeepingLogs(req: Request, res: Response) {
    try {
      const { date, month } = req.query as { date?: string; month?: string };

      let sql = `
        SELECT c.MaChamCong, c.NgayChamCong, c.TienLuongCa, c.TrangThai, c.GhiChu,
               n.MaNhanVien, n.HoTen, cv.TenChucVu, ca.MaCa, ca.TenCa, ca.GioBatDau, ca.GioKetThuc
        FROM CHAM_CONG_CA c
        JOIN NHAN_VIEN n ON c.MaNhanVien = n.MaNhanVien
        JOIN CHUC_VU cv ON n.MaChucVu = cv.MaChucVu
        JOIN CA_LAM_VIEC ca ON c.MaCa = ca.MaCa
      `;
      const params: any[] = [];

      if (date) {
        sql += ' WHERE substr(c.NgayChamCong, 1, 10) = ?';
        params.push(date.slice(0, 10));
      } else if (month) {
        sql += ' WHERE substr(c.NgayChamCong, 1, 7) = ?';
        params.push(month.slice(0, 7));
      }

      sql += ' ORDER BY c.NgayChamCong DESC, c.MaChamCong DESC LIMIT 100';

      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, data: logs });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Chấm ca làm việc cho nhân viên
   */
  public static recordTimekeeping(req: Request, res: Response) {
    try {
      const { maNhanVien, maCa, ngayChamCong = new Date().toISOString().slice(0, 10), tienLuongCa, ghiChu } = req.body;

      if (!maNhanVien || !maCa) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn nhân viên và ca làm việc' });
      }

      // Lấy thông tin ca làm
      const ca = db.prepare('SELECT * FROM CA_LAM_VIEC WHERE MaCa = ?').get(maCa) as any;
      const targetDate = ngayChamCong.slice(0, 10);

      // Chống chấm trùng ca cho 1 nhân viên trong cùng 1 ngày
      const existingRecord = db.prepare(`
        SELECT MaChamCong FROM CHAM_CONG_CA
        WHERE MaNhanVien = ? AND MaCa = ? AND substr(NgayChamCong, 1, 10) = ?
      `).get(maNhanVien, maCa, targetDate) as any;

      if (existingRecord) {
        return res.status(400).json({
          success: false,
          message: `Nhân viên này đã được chấm ca ${ca?.TenCa || maCa} trong ngày ${targetDate} rồi! Không thể chấm trùng lặp.`
        });
      }

      const defaultWage = ca ? ca.TienCongTheoCa : 200000;
      const finalWage = tienLuongCa ? parseFloat(tienLuongCa) : defaultWage;

      const maChamCong = `CC_${Date.now()}`;

      db.prepare(`
        INSERT INTO CHAM_CONG_CA (MaChamCong, MaNhanVien, MaCa, NgayChamCong, TienLuongCa, TrangThai, GhiChu)
        VALUES (?, ?, ?, ?, ?, 'DaDuyet', ?)
      `).run(maChamCong, maNhanVien, maCa, targetDate, finalWage, ghiChu || 'Chấm công hoàn thành ca');

      res.status(201).json({
        success: true,
        message: 'Đã chấm ca làm việc thành công!',
        data: { maChamCong, maNhanVien, tienLuongCa: finalWage }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Xóa bản ghi chấm ca
   */
  public static deleteTimekeeping(req: Request, res: Response) {
    try {
      const { id } = req.params;
      db.prepare('DELETE FROM CHAM_CONG_CA WHERE MaChamCong = ?').run(id);
      res.json({ success: true, message: 'Đã xóa bản ghi chấm ca' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Bảng tổng hợp lương theo ca tháng này (Tính động theo chức vụ & không bỏ sót nhân viên đã nghỉ)
   */
  public static getPayrollSummary(req: Request, res: Response) {
    try {
      const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

      const employees = db.prepare(`
        SELECT n.MaNhanVien, n.HoTen, n.TrangThaiLamViec, cv.MaChucVu, cv.TenChucVu, b.TenBoPhan, t.VaiTro,
               COALESCE((
                 SELECT COUNT(*) FROM CHAM_CONG_CA cc 
                 WHERE cc.MaNhanVien = n.MaNhanVien AND substr(cc.NgayChamCong, 1, 7) = ?
               ), 0) as TongSoCa,
               COALESCE((
                 SELECT SUM(cc.TienLuongCa) FROM CHAM_CONG_CA cc 
                 WHERE cc.MaNhanVien = n.MaNhanVien AND substr(cc.NgayChamCong, 1, 7) = ?
               ), 0) as TongLuongCa
        FROM NHAN_VIEN n
        LEFT JOIN CHUC_VU cv ON n.MaChucVu = cv.MaChucVu
        LEFT JOIN DON_VI_BO_PHAN b ON n.MaBoPhan = b.MaBoPhan
        LEFT JOIN TAI_KHOAN t ON n.MaNhanVien = t.MaNhanVien
        WHERE n.TrangThaiLamViec = 'DangLamViec' 
           OR (SELECT COUNT(*) FROM CHAM_CONG_CA cc WHERE cc.MaNhanVien = n.MaNhanVien AND substr(cc.NgayChamCong, 1, 7) = ?) > 0
        ORDER BY n.MaNhanVien ASC
      `).all(month, month, month) as any[];

      // Phụ cấp tính theo Chức vụ / Vai trò (Không hardcode ID nhân viên)
      const summary = employees.map(e => {
        let phuCap = 0;
        if (e.MaChucVu === 'CV_MGR' || e.VaiTro === 'QuanLy') {
          phuCap = 500000; // Phụ cấp trách nhiệm Quản lý
        } else if (e.MaChucVu === 'CV_BAR' || e.VaiTro === 'PhaChe') {
          phuCap = 300000; // Phụ cấp kỹ thuật Trưởng Pha chế
        }

        const tongLuongCa = Number(e.TongLuongCa || 0);
        const thucLinh = tongLuongCa + phuCap;

        return {
          ...e,
          phuCap,
          thucLinh,
          luongMoiCa: e.TongSoCa > 0 ? Math.round(tongLuongCa / e.TongSoCa) : 200000
        };
      });

      res.json({ success: true, month, data: summary });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}
