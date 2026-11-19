import { Request, Response, NextFunction } from 'express';
import { Role } from '../types/index.js';
import { db } from '../db/database.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    maNhanVien: string;
    hoTen: string;
    vaiTro: Role;
    tenDangNhap: string;
  };
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // 1. Kiểm tra Token trong Header Authorization (Bearer <base64-token>)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7).trim();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      if (decoded && decoded.maNhanVien && decoded.vaiTro) {
        req.user = {
          maNhanVien: decoded.maNhanVien,
          hoTen: decoded.hoTen || decoded.tenDangNhap,
          vaiTro: decoded.vaiTro as Role,
          tenDangNhap: decoded.tenDangNhap
        };
        return next();
      }
    } catch (e) {
      console.warn('Lỗi parse auth token:', e);
    }
  }

  // 2. Đọc từ header x-user-role hoặc query param role (hỗ trợ client POS & testing)
  const userHeader = (req.headers['x-user-role'] as string) || (req.query.role as string);
  const usernameHeader = req.headers['x-username'] as string || 'cashier';

  if (userHeader) {
    let maNv = 'NV03';
    let hoTen = 'Lê Thị Mai (Thu Ngân)';
    if (userHeader === 'ChuQuan') {
      maNv = 'NV01';
      hoTen = 'Nguyễn Hoàng Nam (Chủ Quán)';
    } else if (userHeader === 'QuanLy' || userHeader === 'Admin') {
      maNv = 'NV02';
      hoTen = 'Trần Minh Tuấn (Quản Lý Admin)';
    } else if (userHeader === 'PhaChe') {
      maNv = 'NV04';
      hoTen = 'Phạm Đăng Khoa (Barista)';
    }

    req.user = {
      maNhanVien: maNv,
      hoTen: hoTen,
      vaiTro: userHeader as Role,
      tenDangNhap: usernameHeader
    };
    return next();
  }

  // 3. Tra cứu theo tên đăng nhập mặc định
  const account = db.prepare(`
    SELECT t.MaTaiKhoan, t.VaiTro, t.TenDangNhap, n.MaNhanVien, n.HoTen
    FROM TAI_KHOAN t
    JOIN NHAN_VIEN n ON t.MaNhanVien = n.MaNhanVien
    WHERE t.TenDangNhap = ? AND t.KichHoat = 1
  `).get(usernameHeader) as any;

  if (account) {
    req.user = {
      maNhanVien: account.MaNhanVien,
      hoTen: account.HoTen,
      vaiTro: account.VaiTro as Role,
      tenDangNhap: account.TenDangNhap
    };
  } else {
    // Fallback default
    req.user = {
      maNhanVien: 'NV02',
      hoTen: 'Trần Minh Tuấn (Quản lý Admin)',
      vaiTro: 'QuanLy',
      tenDangNhap: 'manager'
    };
  }

  next();
}

export function requireRoles(...allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Chưa xác thực người dùng. Vui lòng đăng nhập!' });
    }

    if (!allowedRoles.includes(req.user.vaiTro) && req.user.vaiTro !== 'ChuQuan' && req.user.vaiTro !== 'QuanLy') {
      return res.status(403).json({
        success: false,
        message: `Từ chối truy cập: Vai trò '${req.user.vaiTro}' không có quyền thực hiện thao tác này.`
      });
    }

    next();
  };
}
