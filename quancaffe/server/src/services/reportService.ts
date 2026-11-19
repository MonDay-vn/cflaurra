import { db } from '../db/database.js';

export class ReportService {
  /**
   * Báo cáo Kết quả Hoạt động Kinh doanh Lãi - Lỗ (Profit & Loss - P&L)
   * Hỗ trợ xem linh hoạt theo ngày cụ thể (YYYY-MM-DD), hôm nay, hôm qua hoặc khoảng thời gian
   */
  public static getProfitAndLoss(startDate?: string, endDate?: string) {
    let tuNgayStr = '2000-01-01';
    let denNgayStr = '2099-12-31';
    let isSingleDay = false;

    if (startDate) {
      tuNgayStr = startDate.slice(0, 10);
      denNgayStr = endDate ? endDate.slice(0, 10) : tuNgayStr;
      if (tuNgayStr === denNgayStr) {
        isSingleDay = true;
      }
    } else if (endDate) {
      denNgayStr = endDate.slice(0, 10);
      tuNgayStr = denNgayStr;
      isSingleDay = true;
    }

    // 1. Tổng doanh thu bán hàng (Hóa đơn đã thanh toán)
    const dtRow = db.prepare(`
      SELECT COALESCE(SUM(TienMatThucThu), 0) as DoanhThu,
             COUNT(SoHoaDon) as TongDon
      FROM HOA_DON_BAN_HANG
      WHERE TrangThaiThanhToan = 'DaThanhToan'
        AND substr(NgayGioLap, 1, 10) BETWEEN ? AND ?
    `).get(tuNgayStr, denNgayStr) as any;
    const doanhThuBanHang = dtRow ? dtRow.DoanhThu : 0;
    const tongDonHang = dtRow ? dtRow.TongDon : 0;

    // 2. Tổng giá vốn hàng bán (COGS - Cost of Goods Sold)
    const cogsRow = db.prepare(`
      SELECT COALESCE(SUM(ct.SoLuong * ctm.SoLuongDinhMuc * vt.DonGiaBinhQuan), 0) as COGS
      FROM HOA_DON_BAN_HANG hd
      JOIN CHI_TIET_HOA_DON ct ON hd.SoHoaDon = ct.SoHoaDon
      JOIN CONG_THUC_MON ctm ON ct.MaMon = ctm.MaMon
      JOIN VAT_TU_NGUYEN_LIEU vt ON ctm.MaVatTu = vt.MaVatTu
      WHERE hd.TrangThaiThanhToan = 'DaThanhToan'
        AND substr(hd.NgayGioLap, 1, 10) BETWEEN ? AND ?
    `).get(tuNgayStr, denNgayStr) as any;
    const giaVonHangBan = cogsRow ? cogsRow.COGS : 0;

    // 3. Chi phí hao hụt kho
    const haoHutRow = db.prepare(`
      SELECT COALESCE(SUM(TongGiaTriHaoHut), 0) as HaoHut
      FROM PHIEU_HUY_HAO_HUT
      WHERE substr(NgayHuy, 1, 10) BETWEEN ? AND ?
    `).get(tuNgayStr, denNgayStr) as any;
    const chiPhiHaoHut = haoHutRow ? haoHutRow.HaoHut : 0;

    // 4. Thu khác từ sổ quỹ
    const thuKhacRow = db.prepare(`
      SELECT COALESCE(SUM(SoTien), 0) as ThuKhac
      FROM SO_QUY_THU_CHI
      WHERE LoaiPhieu = 'Thu'
        AND (ChungTuGoc IS NULL OR ChungTuGoc NOT LIKE 'HD%')
        AND substr(NgayPhatSinh, 1, 10) BETWEEN ? AND ?
    `).get(tuNgayStr, denNgayStr) as any;
    const thuKhac = thuKhacRow ? thuKhacRow.ThuKhac : 0;

    // 5. Chi phí vận hành (điện, nước, mặt bằng...)
    const chiPhiVanHanhRow = db.prepare(`
      SELECT COALESCE(SUM(SoTien), 0) as ChiPhiVH
      FROM SO_QUY_THU_CHI
      WHERE LoaiPhieu = 'Chi'
        AND (ChungTuGoc IS NULL OR ChungTuGoc NOT LIKE 'PN%')
        AND substr(NgayPhatSinh, 1, 10) BETWEEN ? AND ?
    `).get(tuNgayStr, denNgayStr) as any;
    const chiPhiVanHanh = chiPhiVanHanhRow ? chiPhiVanHanhRow.ChiPhiVH : 0;

    // 6. Chi phí lương nhân viên (Tính theo ca làm việc khi xem theo ngày)
    let chiPhiLuong = 0;
    try {
      if (isSingleDay) {
        // Khi xem theo ngày cụ thể: Lấy tổng tiền các ca chấm công trong ngày đó
        const shiftSalaryRow = db.prepare(`
          SELECT COALESCE(SUM(TienLuongCa), 0) as LuongCa
          FROM CHAM_CONG_CA
          WHERE substr(NgayChamCong, 1, 10) = ?
        `).get(tuNgayStr) as any;
        
        chiPhiLuong = shiftSalaryRow ? shiftSalaryRow.LuongCa : 0;
        // Nếu ngày xem chưa có bản ghi chấm ca nhưng có doanh thu, ước tính 2 ca chuẩn
        if (chiPhiLuong === 0 && tongDonHang > 0) {
          chiPhiLuong = 400000;
        }
      } else {
        // Khi xem khoảng thời gian dài: Lấy tổng tiền chấm ca hoặc bảng thanh toán lương
        const shiftSalaryRow = db.prepare(`
          SELECT COALESCE(SUM(TienLuongCa), 0) as LuongCa
          FROM CHAM_CONG_CA
          WHERE substr(NgayChamCong, 1, 10) BETWEEN ? AND ?
        `).get(tuNgayStr, denNgayStr) as any;

        if (shiftSalaryRow && shiftSalaryRow.LuongCa > 0) {
          chiPhiLuong = shiftSalaryRow.LuongCa;
        } else {
          const luongRow = db.prepare(`
            SELECT COALESCE(SUM(ThucLinh), 0) as ChiPhiLuong
            FROM BANG_THANH_TOAN_LUONG
            WHERE substr(NgayTinhLuong, 1, 10) BETWEEN ? AND ?
          `).get(tuNgayStr, denNgayStr) as any;
          chiPhiLuong = luongRow ? luongRow.ChiPhiLuong : 0;
        }
      }
    } catch (e) {
      chiPhiLuong = 0;
    }

    // Tính toán chỉ số P&L
    const loiNhuanGop = doanhThuBanHang - giaVonHangBan;
    const tiSuatLoiNhuanGop = doanhThuBanHang > 0 ? (loiNhuanGop / doanhThuBanHang) * 100 : 0;

    const tongChiPhiHoatDong = chiPhiVanHanh + chiPhiLuong + chiPhiHaoHut;
    const loiNhuanRong = loiNhuanGop + thuKhac - tongChiPhiHoatDong;
    const tiSuatLoiNhuanRong = doanhThuBanHang > 0 ? (loiNhuanRong / doanhThuBanHang) * 100 : 0;

    // Chi tiết chi phí hoạt động theo nhóm
    const expenseBreakdown = db.prepare(`
      SELECT LyDo, SUM(SoTien) as SoTien
      FROM SO_QUY_THU_CHI
      WHERE LoaiPhieu = 'Chi'
        AND (ChungTuGoc IS NULL OR ChungTuGoc NOT LIKE 'PN%')
        AND substr(NgayPhatSinh, 1, 10) BETWEEN ? AND ?
      GROUP BY LyDo
    `).all(tuNgayStr, denNgayStr) as any[];

    // Top 5 món bán chạy nhất
    const topMon = db.prepare(`
      SELECT m.TenMon, SUM(ct.SoLuong) as SoLuongBan, SUM(ct.ThanhTien) as DoanhThuMon
      FROM CHI_TIET_HOA_DON ct
      JOIN HOA_DON_BAN_HANG hd ON ct.SoHoaDon = hd.SoHoaDon
      JOIN DANH_MUC_MON m ON ct.MaMon = m.MaMon
      WHERE hd.TrangThaiThanhToan = 'DaThanhToan'
        AND substr(hd.NgayGioLap, 1, 10) BETWEEN ? AND ?
      GROUP BY m.MaMon
      ORDER BY SoLuongBan DESC
      LIMIT 5
    `).all(tuNgayStr, denNgayStr) as any[];

    return {
      tuNgay: tuNgayStr,
      denNgay: denNgayStr,
      isSingleDay,
      selectedDate: tuNgayStr,
      tongDonHang,
      doanhThuBanHang,
      giaVonHangBan_COGS: giaVonHangBan,
      loiNhuanGop,
      tiSuatLoiNhuanGop: Number(tiSuatLoiNhuanGop.toFixed(1)),
      thuKhac,
      chiPhiVanHanh,
      chiPhiLuong,
      chiPhiHaoHut,
      tongChiPhiHoatDong,
      loiNhuanRong_NetProfit: loiNhuanRong,
      tiSuatLoiNhuanRong: Number(tiSuatLoiNhuanRong.toFixed(1)),
      expenseBreakdown,
      topMon
    };
  }
}
