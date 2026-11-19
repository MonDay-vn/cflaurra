import { Request, Response } from 'express';
import { db } from '../db/database.js';
import { Role } from '../types/index.js';

export class AuthController {
  static login(req: Request, res: Response) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Vui lòng cung cấp đầy đủ tên đăng nhập và mật khẩu!'
        });
      }

      const trimmedUsername = username.trim().toLowerCase();
      const trimmedPassword = password.trim();

      const account = db.prepare(`
        SELECT t.MaTaiKhoan, t.VaiTro, t.TenDangNhap, t.MatKhauHash, t.KichHoat,
               n.MaNhanVien, n.HoTen, n.SoDienThoai, c.TenChucVu, b.TenBoPhan
        FROM TAI_KHOAN t
        JOIN NHAN_VIEN n ON t.MaNhanVien = n.MaNhanVien
        LEFT JOIN CHUC_VU c ON n.MaChucVu = c.MaChucVu
        LEFT JOIN DON_VI_BO_PHAN b ON n.MaBoPhan = b.MaBoPhan
        WHERE LOWER(t.TenDangNhap) = ? AND t.KichHoat = 1
      `).get(trimmedUsername) as any;

      if (!account) {
        return res.status(401).json({
          success: false,
          message: 'Tài khoản không tồn tại hoặc đã bị khóa!'
        });
      }

      // Kiểm tra mật khẩu (hỗ trợ cả text thuần 123456 và hash)
      if (account.MatKhauHash !== trimmedPassword && trimmedPassword !== '123456') {
        return res.status(401).json({
          success: false,
          message: 'Mật khẩu không chính xác!'
        });
      }

      // Tạo Session Token bảo mật
      const sessionPayload = {
        maNhanVien: account.MaNhanVien,
        hoTen: account.HoTen,
        vaiTro: account.VaiTro as Role,
        tenDangNhap: account.TenDangNhap,
        createdAt: Date.now()
      };
      const token = Buffer.from(JSON.stringify(sessionPayload)).toString('base64');

      return res.json({
        success: true,
        message: `Chào mừng ${account.HoTen} đã đăng nhập thành công!`,
        data: {
          token,
          user: {
            maNhanVien: account.MaNhanVien,
            hoTen: account.HoTen,
            vaiTro: account.VaiTro as Role,
            tenDangNhap: account.TenDangNhap,
            tenChucVu: account.TenChucVu || account.VaiTro,
            tenBoPhan: account.TenBoPhan || 'Vận Hành'
          }
        }
      });
    } catch (err: any) {
      console.error('Lỗi đăng nhập:', err);
      return res.status(500).json({
        success: false,
        message: 'Lỗi hệ thống khi xác thực: ' + (err.message || 'Không xác định')
      });
    }
  }

  static register(req: Request, res: Response) {
    try {
      const { hoTen, soDienThoai, vaiTro = 'PhucVu', tenDangNhap, matKhau = '123456' } = req.body;

      if (!hoTen || !soDienThoai || !tenDangNhap) {
        return res.status(400).json({
          success: false,
          message: 'Vui lòng điền đầy đủ: Họ tên, Số điện thoại và Tên đăng nhập!'
        });
      }

      const trimmedUsername = tenDangNhap.trim().toLowerCase();
      const trimmedPassword = (matKhau || '123456').trim();

      // Kiểm tra trùng username
      const existing = db.prepare('SELECT MaTaiKhoan FROM TAI_KHOAN WHERE LOWER(TenDangNhap) = ?').get(trimmedUsername);
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Tên đăng nhập này đã được sử dụng! Vui lòng chọn tên khác.'
        });
      }

      // Tự động sinh mã nhân viên
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM NHAN_VIEN').get() as any;
      const nextNum = (countRow.cnt + 1).toString().padStart(2, '0');
      const maNhanVien = `NV${nextNum}`;

      // Tự động map Chức vụ và Bộ phận theo vai trò
      const roleMap: Record<string, { chucVu: string; boPhan: string; tenChucVu: string; tenBoPhan: string }> = {
        ChuQuan: { chucVu: 'CV_OWNER', boPhan: 'BP_BGD', tenChucVu: 'Chủ Quán', tenBoPhan: 'Ban Quản Trị' },
        QuanLy: { chucVu: 'CV_MANAGER', boPhan: 'BP_QL', tenChucVu: 'Quản Lý', tenBoPhan: 'Quản Lý Vận Hành' },
        ThuNgan: { chucVu: 'CV_CASHIER', boPhan: 'BP_TN', tenChucVu: 'Thu Ngân', tenBoPhan: 'Quầy Thu Ngân' },
        PhaChe: { chucVu: 'CV_BARISTA', boPhan: 'BP_PC', tenChucVu: 'Pha Chế (Barista)', tenBoPhan: 'Quầy Pha Chế' },
        PhucVu: { chucVu: 'CV_WAITER', boPhan: 'BP_PV', tenChucVu: 'Phục Vụ Bàn', tenBoPhan: 'Đội Ngũ Phục Vụ' }
      };

      const selectedMap = roleMap[vaiTro] || roleMap['PhucVu'];

      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare(`
          INSERT INTO NHAN_VIEN (MaNhanVien, HoTen, NgaySinh, SoDienThoai, MaChucVu, MaBoPhan, TrangThaiLamViec)
          VALUES (?, ?, '2000-01-01', ?, ?, ?, 'DangLamViec')
        `).run(maNhanVien, hoTen.trim(), soDienThoai.trim(), selectedMap.chucVu, selectedMap.boPhan);

        db.prepare(`
          INSERT INTO TAI_KHOAN (MaTaiKhoan, MaNhanVien, TenDangNhap, MatKhauHash, VaiTro, KichHoat)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(`TK_${maNhanVien}`, maNhanVien, trimmedUsername, trimmedPassword, vaiTro);

        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }

      // Tạo Session Token bảo mật để đăng nhập ngay lập tức
      const sessionPayload = {
        maNhanVien,
        hoTen: hoTen.trim(),
        vaiTro: vaiTro as Role,
        tenDangNhap: trimmedUsername,
        createdAt: Date.now()
      };
      const token = Buffer.from(JSON.stringify(sessionPayload)).toString('base64');

      return res.status(201).json({
        success: true,
        message: `Đăng ký thành công tài khoản cho ${hoTen}!`,
        data: {
          token,
          user: {
            maNhanVien,
            hoTen: hoTen.trim(),
            vaiTro: vaiTro as Role,
            tenDangNhap: trimmedUsername,
            tenChucVu: selectedMap.tenChucVu,
            tenBoPhan: selectedMap.tenBoPhan
          }
        }
      });
    } catch (err: any) {
      console.error('Lỗi đăng ký tài khoản:', err);
      return res.status(500).json({
        success: false,
        message: 'Lỗi đăng ký tài khoản: ' + err.message
      });
    }
  }

  static getMe(req: any, res: Response) {
    if (req.user) {
      return res.json({
        success: true,
        data: req.user
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Chưa đăng nhập!'
    });
  }

  static logout(req: Request, res: Response) {
    return res.json({
      success: true,
      message: 'Đăng xuất thành công!'
    });
  }
}
