// =====================================================================================
// FRONTEND CLIENT APPLICATION (CÀ PHÊ PHỐ XANH - MULTI-TAB F&B POS & KDS)
// =====================================================================================

const AppState = {
  currentRole: 'QuanLy', // ChuQuan, QuanLy, ThuNgan, PhaChe, PhucVu (Mặc định Quản Lý Admin toàn quyền)
  currentUser: { maNhanVien: 'NV02', hoTen: 'Trần Minh Tuấn (Quản lý Admin)', tenDangNhap: 'manager' },
  isSimulatedOffline: false,
  isSidebarCollapsed: false,
  
  // HỆ THỐNG TAB ĐA NHIỆM CHO TỪNG BÀN (DYNAMIC MULTI-TAB WORKSPACE)
  posTabs: [
    { id: 'floor', title: 'Sơ Đồ Toàn Quán', type: 'floor' }
  ],
  activePosTabId: 'floor',
  takeawayCounter: 1,

  // Dữ liệu danh mục & nhà hàng
  menuGroups: [],
  menuItems: [],
  tables: [],
  areas: [],
  kdsTickets: [],
  currentShift: null,
  stockAlerts: [],
  socket: null,
  activeMainTab: 'pos',
  activeCategory: 'all'
};

// Biến trạng thái chống Double Submit / Race Condition khi bấm nút "Gửi Bếp" (POS)
let isSubmittingKDS = false;

// SLA Timer Interval cho màn hình KDS (Cập nhật thời gian thực mm:ss mỗi giây)
let kdsSlaInterval = null;

// Bộ lọc danh sách 86'd items trên modal KDS (all | out | available)
let kds86ActiveFilter = 'all';

// Interceptor toàn cục: Tự động đính kèm Token xác thực & Role trong mọi request gửi tới backend
const _nativeFetch = window.fetch;
window.fetch = function(url, options = {}) {
  if (typeof url === 'string' && url.startsWith('/api')) {
    options = options || {};
    options.headers = options.headers || {};
    const token = localStorage.getItem('pho_xanh_token');
    if (options.headers instanceof Headers) {
      if (!options.headers.has('x-user-role')) {
        options.headers.set('x-user-role', AppState.currentRole);
      }
      if (token && !options.headers.has('Authorization')) {
        options.headers.set('Authorization', 'Bearer ' + token);
      }
    } else {
      options.headers['x-user-role'] = options.headers['x-user-role'] || AppState.currentRole;
      if (token && !options.headers['Authorization']) {
        options.headers['Authorization'] = 'Bearer ' + token;
      }
    }
  }
  return _nativeFetch.call(this, url, options);
};

// =====================================================================================
// KHỞI TẠO HỆ THỐNG
// =====================================================================================
// =====================================================================================
// GLOBAL COMPONENT & FILTER STATE (KHAI BÁO TOÀN CỤC TRÊN ĐẦU ĐỂ TRÁNH TEMPORAL DEAD ZONE)
// =====================================================================================
let selectedFloorArea = 'all';
let selectedPayMethod = 'TienMat';
let currentVoucher = null;
let pendingCancelItem = null;
let pnlCurrentRange = 'today';
let pnlStartDate = new Date().toISOString().slice(0, 10);
let pnlEndDate = new Date().toISOString().slice(0, 10);
let inventoryMaterialsData = [];
let inventorySuppliersData = [];
let inventoryCurrentFilter = 'all';
let inventorySearchQuery = '';
let staffEmployeesList = [];
let staffMetadata = { chucVu: [], boPhan: [], caLamViec: [] };
let staffShiftsList = [];
let staffActiveSubtab = 'employees';
let baristaRecipesList = [];
let sidebarLogoRotation = 0;



// Đồng hồ thời gian thực
function initClock() {
  const clockEl = document.getElementById('live-clock');
  const dateEl = document.getElementById('current-date');
  setInterval(() => {
    const now = new Date();
    if (clockEl) clockEl.textContent = now.toLocaleTimeString('vi-VN');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('vi-VN');
  }, 1000);
}

// =====================================================================================
// WEBSOCKET REAL-TIME SYNC (KDS & ORDER UPDATES)
// =====================================================================================
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    AppState.socket = new WebSocket(wsUrl);

    AppState.socket.onopen = () => {
      console.log('[WS] Đã kết nối tới Real-time KDS Hub');
      updateNetworkBadge(true);
    };

    AppState.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSocketMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error', e);
      }
    };

    AppState.socket.onclose = () => {
      console.warn('[WS] Mất kết nối. Đang thử lại sau 3s...');
      updateNetworkBadge(false);
      setTimeout(initWebSocket, 3000);
    };
  } catch (err) {
    console.error('[WS] Setup failed', err);
    updateNetworkBadge(false);
  }
}

function handleSocketMessage(msg) {
  console.log('[WS Event]:', msg.type, msg.payload);

  switch (msg.type) {
    case 'ORDER_NEW':
      if (window.playNotificationChime) window.playNotificationChime();
      scheduleKdsTicketsReload(50);
      loadTables();
      loadShiftData();
      if (msg.payload.isAddOn || (msg.payload.lanGoi && msg.payload.lanGoi > 1)) {
        showToast(`🛎️ Có món GỌI THÊM từ ${msg.payload.tenBan || msg.payload.maBan || 'Bàn'}: Đợt ${msg.payload.lanGoi || 2}!`, 'warning');
      } else {
        showToast(`Có đơn hàng mới: ${msg.payload.soHoaDon} (${msg.payload.tenBan || msg.payload.maBan || 'Mang đi'})`, 'success');
      }
      break;

    case 'KDS_ITEM_STATUS':
      scheduleKdsTicketsReload(80);
      break;

    case 'KDS_ORDER_COMPLETED':
      if (window.playNotificationChime) window.playNotificationChime();
      showToast(`ĐỒ UỐNG ĐÃ HOÀN TẤT: ${msg.payload.soHoaDon} (${msg.payload.maBan || 'Mang đi'}) - Mời phục vụ lấy đồ!`, 'success');
      scheduleKdsTicketsReload(80);
      break;

    case 'STOCK_ALERT':
      handleStockAlert(msg.payload);
      break;

    case 'TABLE_UPDATED':
      loadTables();
      break;

    case 'MENU_UPDATED':
      if (msg.payload && msg.payload.maMon) {
        const item = AppState.menuItems.find(m => m.MaMon === msg.payload.maMon);
        if (item) {
          if (msg.payload.dangKinhDoanh !== undefined) {
            item.DangKinhDoanh = msg.payload.dangKinhDoanh;
          }
          if (msg.payload.is_available !== undefined) {
            item.is_available = msg.payload.is_available;
          } else {
            item.is_available = item.DangKinhDoanh === 1;
          }
        }
        renderMenuItems();
        renderKds86List();
        updateKds86Badge();
        const dishName = msg.payload.tenMon || item?.TenMon || msg.payload.maMon;
        const isAvail = msg.payload.is_available ?? (msg.payload.dangKinhDoanh === 1);
        if (!isAvail) {
          showToast(`🚫 Bếp vừa báo TẠM HẾT: "${dishName}"! Món đã được khóa trên POS.`, 'warning');
        } else {
          showToast(`🟢 Món "${dishName}" đã được mở bán trở lại trên POS!`, 'success');
        }
      }
      break;

    case 'SHIFT_CHANGED':
      loadShiftData();
      break;
  }
}

function handleStockAlert(alert) {
  AppState.stockAlerts.push(alert);
  updateStockAlertBadges();
  showToast(`CẢNH BÁO TỒN KHO: ${alert.tenVatTu} chỉ còn ${alert.soLuongTonHienTai} ${alert.donViTinh} (ngưỡng tối thiểu: ${alert.mucToiThieuCanCanhBao})`, 'warning');
}

function updateStockAlertBadges() {
  const count = AppState.stockAlerts.length;
  const badge = document.getElementById('badge-stock-count');
  const badgeMini = document.getElementById('badge-stock-count-mini');

  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (badgeMini) {
    if (count > 0) {
      badgeMini.textContent = count;
      badgeMini.classList.remove('hidden');
    } else {
      badgeMini.classList.add('hidden');
    }
  }
}

// =====================================================================================
// DATA LOADING
// =====================================================================================
async function loadInitialData() {
  await Promise.all([
    loadMenu(),
    loadTables(),
    loadShiftData(),
    loadKdsTickets()
  ]);
}

async function loadMenu() {
  try {
    const res = await fetch('/api/menu');
    const data = await res.json();
    if (data.success) {
      AppState.menuGroups = data.data.groups;
      AppState.menuItems = data.data.items || [];
      AppState.menuItems.forEach(i => {
        if (i.is_available === undefined) i.is_available = i.DangKinhDoanh === 1;
      });
      renderCategories();
      renderMenuItems();
      updateKds86Badge();
    }
  } catch (err) {
    console.error('Lỗi nạp menu', err);
  }
}

async function loadTables() {
  try {
    const res = await fetch('/api/tables');
    const data = await res.json();
    if (data.success) {
      AppState.areas = data.data.areas;
      AppState.tables = data.data.tables;
      renderFloorAreaFilters();
      renderFloorTables();
    }
  } catch (err) {
    console.error('Lỗi nạp danh sách bàn', err);
  }
}

async function loadShiftData() {
  try {
    const [shiftRes, histRes, metaRes, empRes] = await Promise.all([
      fetch('/api/shift/current'),
      fetch('/api/shift/history'),
      fetch('/api/employees/metadata'),
      fetch('/api/employees')
    ]);

    const [shiftData, histData, metaData, empData] = await Promise.all([
      shiftRes.json(),
      histRes.json(),
      metaRes.json(),
      empRes.json()
    ]);

    const activeCard = document.getElementById('shift-active-card');
    const closedCard = document.getElementById('shift-closed-card');
    const statusPill = document.getElementById('shift-status-pill');
    const headerShiftName = document.getElementById('header-shift-name');

    // Luôn nạp sẵn danh mục Ca làm việc & Nhân viên vào form Mở Ca
    if (metaData.success && metaData.data) {
      const caList = metaData.data.caLamViec || metaData.data.caLamViecList || [];
      const caSelect = document.getElementById('open-shift-ca');
      if (caSelect && caList.length > 0) {
        caSelect.innerHTML = caList.map(ca => `
          <option value="${ca.MaCa}">${ca.TenCa} (${ca.GioBatDau} - ${ca.GioKetThuc})</option>
        `).join('');
      }
    }

    if (empData.success && empData.data) {
      const cashierSelect = document.getElementById('open-shift-cashier');
      if (cashierSelect && empData.data.length > 0) {
        cashierSelect.innerHTML = empData.data.map(emp => `
          <option value="${emp.MaNhanVien}" ${emp.MaNhanVien === 'NV03' ? 'selected' : ''}>
            ${emp.HoTen} (${emp.TenChucVu || emp.MaNhanVien})
          </option>
        `).join('');
      }
    }

    if (shiftData.success && shiftData.data && shiftData.data.isOpen) {
      AppState.currentShift = shiftData.data;
      if (activeCard) activeCard.classList.remove('hidden');
      if (closedCard) closedCard.classList.add('hidden');
      if (statusPill) {
        statusPill.textContent = `🟢 Đang mở: ${shiftData.data.TenCa || ''}`;
        statusPill.className = 'px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase font-mono border border-emerald-300';
      }
      if (headerShiftName) headerShiftName.textContent = shiftData.data.TenCa || 'Ca Sáng';
      updateShiftUI(shiftData.data);
    } else {
      AppState.currentShift = null;
      if (activeCard) activeCard.classList.add('hidden');
      if (closedCard) closedCard.classList.remove('hidden');
      if (statusPill) {
        statusPill.textContent = '🔴 Két Đang Đóng (Chưa mở ca)';
        statusPill.className = 'px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-rose-100 text-rose-800 uppercase font-mono border border-rose-300';
      }
      if (headerShiftName) headerShiftName.textContent = 'Chưa Mở Ca';
    }

    // Render bảng lịch sử giao ca
    if (histData.success && histData.data) {
      renderShiftHistoryTable(histData.data);
    }

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('Lỗi nạp ca làm việc:', err);
  }
}

async function loadKdsTickets() {
  try {
    const res = await fetch('/api/orders/kds');
    const data = await res.json();
    if (data.success) {
      AppState.kdsTickets = data.data;
      renderKdsTickets();
      const badge = document.getElementById('kds-pending-badge');
      if (badge) badge.textContent = AppState.kdsTickets.length;
    }
  } catch (err) {
    console.error('Lỗi nạp KDS', err);
  }
}

// =====================================================================================
// CƠ CHẾ TAB ĐA NHIỆM CHO TỪNG BÀN (DYNAMIC MULTI-TAB WORKSPACE)
// =====================================================================================

// Lưu trạng thái các tab POS vào bộ nhớ tạm sessionStorage (an toàn, không lỗi)
function saveTabsToStorage() {
  try {
    const tabsToSave = AppState.posTabs.map(t => ({
      id: t.id,
      type: t.type,
      tableId: t.tableId,
      title: t.title,
      tableName: t.tableName,
      areaName: t.areaName,
      status: t.status,
      cart: t.cart,
      customer: t.customer,
      openTime: t.openTime,
      currentOrderCode: t.currentOrderCode,
      activeOrderId: t.activeOrderId
    }));
    sessionStorage.setItem('quancaffe_pos_tabs', JSON.stringify(tabsToSave));
  } catch (e) {
    // Tránh lỗi bảo mật hoặc hạn ngạch lưu trữ trình duyệt
  }
}

// Đồng bộ giỏ hàng của bàn với danh sách món đã gọi trên máy chủ (Database)
// Đảm bảo: món đã lưu trong CSDL luôn được đánh dấu đã gửi bếp (SENT_TO_KDS),
// đồng thời bảo lưu các món mới thêm trong phiên hiện tại chưa gửi (UNSENT).
function syncTabCartWithServerOrder(tab, serverItems) {
  if (!serverItems || serverItems.length === 0) return;

  // Gom các dòng món từ CSDL theo (MaMon + GhiChuTopping)
  const serverMap = new Map();
  serverItems.forEach(it => {
    const note = (it.GhiChuTopping || '').trim();
    const key = `${it.MaMon}___${note}`;
    const existing = serverMap.get(key);
    if (existing) {
      existing.soLuong += it.SoLuong;
      existing.sent_quantity += it.SoLuong;
    } else {
      serverMap.set(key, {
        maMon: it.MaMon,
        tenMon: it.TenMon,
        donGia: it.DonGia,
        soLuong: it.SoLuong,
        sent_quantity: it.SoLuong, // ĐÃ GỬI BẾP
        kds_status: 'SENT_TO_KDS',
        ghiChuTopping: note,
        hinhAnh: it.HinhAnh,
        maChiTiet: it.MaChiTiet,
        lanGoi: it.LanGoi || 1
      });
    }
  });

  if (!tab.cart || tab.cart.length === 0) {
    tab.cart = Array.from(serverMap.values());
    return;
  }

  // Nếu cart đã có món (người dùng đã bấm thêm món gọi thêm nhưng chưa bấm Gửi Bếp):
  tab.cart.forEach(c => {
    const note = (c.ghiChuTopping || '').trim();
    const key = `${c.maMon}___${note}`;
    const srv = serverMap.get(key);
    if (srv) {
      const unsentDelta = Math.max(0, (c.soLuong || 0) - (c.sent_quantity || 0));
      c.sent_quantity = srv.sent_quantity;
      c.soLuong = srv.sent_quantity + unsentDelta;
      c.kds_status = unsentDelta > 0 ? 'UNSENT' : 'SENT_TO_KDS';
      serverMap.delete(key);
    }
  });

  // Món có trong CSDL nhưng trong tab chưa có: thêm vào giỏ với trạng thái Đã gửi
  serverMap.forEach(srv => {
    tab.cart.push(srv);
  });
}

// Mở một tab bàn cụ thể (Ví dụ: Bàn 01)
async function openTableTab(tableId) {
  const table = AppState.tables.find(t => t.MaBan === tableId);
  const tabId = `table_${tableId}`;

  // Kiểm tra xem tab đã mở chưa
  let existingTab = AppState.posTabs.find(t => t.id === tabId);
  if (!existingTab) {
    existingTab = {
      id: tabId,
      type: 'table',
      tableId: tableId,
      title: table ? table.TenBan : `Bàn ${tableId}`,
      tableName: table ? table.TenBan : `Bàn ${tableId}`,
      areaName: table ? table.TenKhuVuc : 'Tầng 1',
      status: table ? table.TrangThai : 'Trong',
      cart: [],
      customer: null,
      openTime: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      currentOrderCode: `HD_${Date.now().toString().slice(-6)}`,
      activeOrderId: null
    };
    AppState.posTabs.push(existingTab);
  }

  // Tải thông tin đơn hàng đang phục vụ (nếu bàn có khách / có đơn chưa thanh toán)
  try {
    const res = await fetch(`/api/tables/${tableId}/order`);
    const data = await res.json();
    if (data.success && data.hasOrder && data.order) {
      existingTab.activeOrderId = data.order.SoHoaDon;
      existingTab.currentOrderCode = data.order.SoHoaDon;
      existingTab.status = 'CoKhach';

      // Nạp và đồng bộ danh sách món từ CSDL
      syncTabCartWithServerOrder(existingTab, data.items || []);

      // Nạp thông tin khách hàng thành viên nếu có
      if (data.order.MaKhachHang) {
        existingTab.customer = {
          MaKhachHang: data.order.MaKhachHang,
          HoTen: data.order.TenKhachHang || 'Khách Thân Thiết',
          DiemTichLuy: data.order.DiemTichLuy || 0,
          HangThanhVien: data.order.HangThanhVien || 'Standard'
        };
      }
    } else {
      if (existingTab.activeOrderId) {
        existingTab.activeOrderId = null;
        existingTab.status = 'Trong';
        existingTab.cart = [];
      }
    }
  } catch (err) {
    console.error('Lỗi nạp đơn hàng bàn:', err);
  }

  // Chuyển tiêu điểm sang tab này
  switchPosTab(tabId);
}

// Mở tab đơn mang đi mới
function openTakeawayTab() {
  const count = AppState.takeawayCounter++;
  const tabId = `takeaway_${count}`;
  const newTab = {
    id: tabId,
    type: 'takeaway',
    title: `🛍️ Mang Đi #${count}`,
    tableName: `Đơn Mang Đi #${count}`,
    areaName: 'Quầy Thu Ngân',
    status: 'Trong',
    cart: [],
    customer: null,
    openTime: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    currentOrderCode: `HD_MD_${Date.now().toString().slice(-4)}`
  };
  AppState.posTabs.push(newTab);
  switchPosTab(tabId);
}

// Đóng một tab bàn
function closePosTab(tabId, event) {
  if (event) event.stopPropagation();

  // Không cho phép đóng tab sơ đồ toàn quán
  if (tabId === 'floor') return;

  const idx = AppState.posTabs.findIndex(t => t.id === tabId);
  if (idx !== -1) {
    AppState.posTabs.splice(idx, 1);
  }

  // Nếu đang đứng ở tab vừa đóng, chuyển sang tab trước đó hoặc 'floor'
  if (AppState.activePosTabId === tabId) {
    const nextTab = AppState.posTabs[Math.max(0, idx - 1)] || AppState.posTabs[0];
    switchPosTab(nextTab.id);
  } else {
    renderPosTableTabs();
  }
}

// Đóng bàn và chuyển trạng thái về BÀN TRỐNG (Cập nhật database & sơ đồ toàn quán)
async function releaseCurrentTable() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.id === 'floor') return;

  // Nếu là tab Mang Đi
  if (currentTab.type === 'takeaway') {
    if (currentTab.cart && currentTab.cart.length > 0) {
      if (!confirm('Đơn mang đi này đang có món. Bạn có chắc muốn hủy và đóng tab không?')) {
        return;
      }
    }
    closePosTab(currentTab.id);
    showToast('Đã đóng đơn mang đi!', 'info');
    return;
  }

  const tableId = currentTab.tableId;
  const tableName = currentTab.tableName || `Bàn ${tableId}`;

  // Cảnh báo nếu bàn đang có món hoặc đơn KDS đang phục vụ
  if ((currentTab.cart && currentTab.cart.length > 0) || currentTab.activeOrderId) {
    const msg = currentTab.activeOrderId
      ? `CẢNH BÁO: ${tableName} đang có đơn phục vụ (${currentTab.activeOrderId}) chưa thanh toán.\n\nBạn có chắc chắn muốn hủy đơn và ĐÓNG BÀN (trả về Bàn Trống) không?`
      : `${tableName} đang có món đã chọn trong giỏ hàng.\n\nBạn có chắc chắn muốn hủy và ĐÓNG BÀN (trả về Bàn Trống) không?`;
    if (!confirm(msg)) {
      return;
    }
  }

  try {
    const res = await fetch(`/api/tables/${tableId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trangThai: 'Trong' })
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.message || 'Không thể đóng bàn');
    }

    // Đóng tab của bàn này
    closePosTab(currentTab.id);

    // Cập nhật trạng thái bộ nhớ client
    const tbl = (AppState.tables || []).find(t => t.MaBan === tableId);
    if (tbl) tbl.TrangThai = 'Trong';

    // Chuyển tiêu điểm về sơ đồ quán & tải lại danh sách bàn
    switchPosTab('floor');
    await loadTables();

    showToast(`Đã đóng ${tableName} và chuyển về trạng thái BÀN TRỐNG!`, 'success');
  } catch (err) {
    console.error('Lỗi khi đóng bàn:', err);
    showToast('Lỗi khi đóng bàn: ' + err.message, 'error');
  }
}
window.releaseCurrentTable = releaseCurrentTable;

// Trả nhanh bàn về trống trực tiếp từ sơ đồ toàn quán
async function quickReleaseTable(tableId, tableName) {
  try {
    const res = await fetch(`/api/tables/${tableId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trangThai: 'Trong' })
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.message || 'Không thể cập nhật trạng thái bàn');
    }

    // Xóa tab bàn nếu đang mở
    const existingIdx = AppState.posTabs.findIndex(t => t.tableId === tableId);
    if (existingIdx !== -1) {
      AppState.posTabs.splice(existingIdx, 1);
      renderPosTableTabs();
    }

    const tbl = (AppState.tables || []).find(t => t.MaBan === tableId);
    if (tbl) tbl.TrangThai = 'Trong';

    await loadTables();
    showToast(`Đã trả ${tableName || tableId} về trạng thái BÀN TRỐNG!`, 'success');
  } catch (err) {
    console.error('Lỗi trả nhanh bàn:', err);
    showToast('Lỗi khi trả bàn: ' + err.message, 'error');
  }
}
window.quickReleaseTable = quickReleaseTable;

// Chuyển đổi tab đang xem (Giữ cố định giao diện và tabs, chuyển động mượt mà êm ái)
function switchPosTab(tabId) {
  AppState.activePosTabId = tabId;
  renderPosTableTabs();
  if (typeof setHeaderVisibility === 'function') setHeaderVisibility(true);

  const floorView = document.getElementById('view-floor-map');
  const tableView = document.getElementById('view-table-detail');

  if (tabId === 'floor') {
    floorView.classList.remove('hidden');
    tableView.classList.add('hidden');
    floorView.classList.remove('animate-fade-in');
    void floorView.offsetWidth;
    floorView.classList.add('animate-fade-in');
    renderFloorTables();
    document.getElementById('btn-floating-pos-cart')?.classList.add('hidden');
  } else {
    floorView.classList.add('hidden');
    tableView.classList.remove('hidden');
    tableView.classList.remove('animate-fade-in');
    void tableView.offsetWidth;
    tableView.classList.add('animate-fade-in');
    document.getElementById('btn-floating-pos-cart')?.classList.remove('hidden');

    const menuSec = document.getElementById('pos-menu-section');
    if (menuSec) { menuSec.classList.remove('hidden'); menuSec.classList.add('flex'); }

    renderCurrentTabDetail();
  }
}

// Chuyển đổi giao diện hoặc mở modal phiếu gọi món
function openPosCartModal() {
  const modal = document.getElementById('modal-pos-cart');
  if (!modal) return;

  const currentTab = getCurrentTab();
  const nameEl = document.getElementById('cart-modal-table-name');
  if (nameEl) {
    if (currentTab) {
      nameEl.textContent = currentTab.tableName || (currentTab.type === 'takeaway' ? 'Đơn Mang Đi' : 'Bàn');
    } else {
      nameEl.textContent = 'Bàn Hiện Tại';
    }
  }

  modal.classList.remove('hidden');
  renderTabCart();
  updateTabCartTotals();
  if (window.lucide) try { window.lucide.createIcons(); } catch (e) {}
}

function closePosCartModal() {
  const modal = document.getElementById('modal-pos-cart');
  if (modal) modal.classList.add('hidden');
}

function switchMobilePosView(view) {
  if (view === 'cart') {
    openPosCartModal();
  } else {
    closePosCartModal();
  }
}
window.openPosCartModal = openPosCartModal;
window.closePosCartModal = closePosCartModal;
window.switchMobilePosView = switchMobilePosView;

window.addEventListener('resize', () => {
  const menuSec = document.getElementById('pos-menu-section');
  if (menuSec) { menuSec.classList.remove('hidden'); menuSec.classList.add('flex'); }
});

// Render thanh Tab bàn ngang
function renderPosTableTabs() {
  const container = document.getElementById('pos-table-tabs-list');
  if (!container) return;

  let html = '';
  AppState.posTabs.forEach(tab => {
    const isActive = AppState.activePosTabId === tab.id;
    const isFloor = tab.id === 'floor';
    const cartCount = tab.cart ? tab.cart.reduce((sum, item) => sum + item.soLuong, 0) : 0;
    const badge = cartCount > 0 ? `<span class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black bg-amber-500 text-white leading-none shadow-2xs">${cartCount}</span>` : '';

    let tabClass = isActive
      ? 'pos-table-tab-active font-extrabold'
      : 'border border-slate-200 bg-white/90 text-slate-700 hover:bg-slate-50 font-semibold';

    let iconHtml = isFloor 
      ? '<i data-lucide="layout-grid" class="w-3.5 h-3.5 text-amber-700"></i>' 
      : tab.type === 'takeaway' 
      ? '<i data-lucide="shopping-bag" class="w-3.5 h-3.5 text-emerald-600"></i>' 
      : '<i data-lucide="coffee" class="w-3.5 h-3.5 text-amber-700"></i>';

    html += `
      <div class="pos-table-tab shrink-0 px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-2 transition cursor-pointer select-none ${tabClass}" data-tab-id="${tab.id}">
        ${iconHtml}
        <span>${tab.title}</span>
        ${badge}
        ${!isFloor ? `<button class="btn-close-tab w-5 h-5 inline-flex items-center justify-center rounded-full hover:bg-amber-100 text-slate-400 hover:text-rose-600 ml-1 transition text-[11px] font-bold cursor-pointer" data-close-id="${tab.id}" title="Đóng tab bàn này">✕</button>` : ''}
      </div>
    `;
  });

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();

  // Gắn sự kiện chuyển tab
  container.querySelectorAll('.pos-table-tab').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      // Nếu click vào nút x đóng tab thì bỏ qua
      if (e.target.closest('.btn-close-tab')) return;
      const tabId = tabEl.getAttribute('data-tab-id');
      switchPosTab(tabId);
    });
  });

  // Gắn sự kiện đóng tab
  container.querySelectorAll('.btn-close-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = btn.getAttribute('data-close-id');
      closePosTab(tabId, e);
    });
  });
}

// Render nội dung của Tab Bàn Đang Chọn
function renderCurrentTabDetail() {
  const currentTab = AppState.posTabs.find(t => t.id === AppState.activePosTabId);
  if (!currentTab || currentTab.id === 'floor') return;

  // Cập nhật Header bàn
  document.getElementById('current-tab-table-title').textContent = `${currentTab.tableName} • ${currentTab.areaName}`;
  document.getElementById('current-tab-table-time').textContent = currentTab.openTime;
  document.getElementById('current-tab-order-code').textContent = currentTab.currentOrderCode;

  const statusEl = document.getElementById('current-tab-table-status');
  if (currentTab.activeOrderId) {
    statusEl.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">🍽️ Đang phục vụ (${currentTab.activeOrderId})</span>`;
  } else if (currentTab.cart && currentTab.cart.length > 0) {
    statusEl.textContent = 'Đang chọn món';
    statusEl.className = 'font-bold text-amber-600';
  } else if (currentTab.status === 'CoKhach') {
    statusEl.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">Có khách (Chưa có món)</span>`;
  } else if (currentTab.status === 'DatTruoc') {
    statusEl.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800">Đặt trước</span>`;
  } else {
    statusEl.textContent = 'Bàn trống';
    statusEl.className = 'font-bold text-emerald-600';
  }

  // Render giỏ hàng của bàn này
  renderTabCart();
  renderMenuItems();
}

// =====================================================================================
// SƠ ĐỒ TOÀN QUÁN (FLOOR MAP OVERVIEW)
// =====================================================================================
// selectedFloorArea defined at top

function renderFloorAreaFilters() {
  const container = document.getElementById('floor-area-filter-container');
  if (!container) return;

  let html = `<button class="floor-area-btn px-3 py-1 rounded-lg text-xs font-bold ${selectedFloorArea === 'all' ? 'active-area-btn font-extrabold' : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200/80'}" data-area="all">Tất cả khu vực</button>`;
  AppState.areas.forEach(a => {
    html += `<button class="floor-area-btn px-3 py-1 rounded-lg text-xs font-bold ${selectedFloorArea === a.MaKhuVuc ? 'active-area-btn font-extrabold' : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200/80'}" data-area="${a.MaKhuVuc}">${a.TenKhuVuc}</button>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('.floor-area-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedFloorArea = btn.getAttribute('data-area');
      renderFloorAreaFilters();
      renderFloorTables();
    });
  });
}

function renderFloorTables() {
  const container = document.getElementById('floor-tables-grid');
  if (!container) return;

  const tablesList = AppState.tables || [];
  const filtered = selectedFloorArea === 'all'
    ? tablesList
    : tablesList.filter(t => t.MaKhuVuc === selectedFloorArea);

  let html = '';
  filtered.forEach(tbl => {
    // Kiểm tra bàn có đang mở tab không
    const isTabOpen = AppState.posTabs.some(t => t.tableId === tbl.MaBan);

    let statusBorder = 'border-emerald-200 bg-emerald-50/50 text-emerald-800';
    let statusDot = 'bg-emerald-500';
    let statusText = 'Trống';

    if (tbl.TrangThai === 'CoKhach') {
      statusBorder = 'border-rose-200 bg-rose-50/50 text-rose-800';
      statusDot = 'bg-rose-500';
      statusText = 'Có khách';
    } else if (tbl.TrangThai === 'DatTruoc') {
      statusBorder = 'border-sky-200 bg-sky-50/50 text-sky-800';
      statusDot = 'bg-sky-500';
      statusText = 'Đặt trước';
    }

    // Tách tên khu vực ngắn gọn (tránh tràn chữ và đè lên tiêu đề)
    const areaName = tbl.TenKhuVuc || '';
    const shortArea = areaName.includes('Tầng 1') ? 'Tầng 1'
                    : areaName.includes('Tầng 2') ? 'Tầng 2'
                    : areaName.includes('Sân Vườn') ? 'Sân Vườn'
                    : (areaName || 'Khu Vực');

    html += `
      <div class="floor-table-card hover-lift p-2.5 sm:p-3.5 rounded-2xl border-2 ${statusBorder} hover:border-amber-500 hover:shadow-md cursor-pointer transition flex flex-col justify-between min-h-[110px] sm:min-h-[120px] shadow-xs relative overflow-hidden" data-table-id="${tbl.MaBan}">
        <!-- Hàng 1: Trạng thái & Nút Trả Trống Nhanh -->
        <div class="flex items-center justify-between gap-1">
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="w-2.5 h-2.5 rounded-full ${statusDot}"></span>
            <span class="text-xs font-bold">${statusText}</span>
          </div>
          ${tbl.TrangThai !== 'Trong' ? `
            <button class="btn-floor-release-table p-1 rounded-lg bg-white/90 hover:bg-emerald-600 hover:text-white text-slate-400 hover:border-emerald-300 border border-slate-200 transition shadow-2xs cursor-pointer shrink-0" data-release-id="${tbl.MaBan}" data-release-name="${tbl.TenBan}" title="Đóng bàn (Trả về Bàn Trống)">
              <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>
            </button>
          ` : ''}
        </div>

        <!-- Hàng 2: Tên bàn & Huy hiệu Đang Mở Tab (Tách riêng hàng, không bị chật chội) -->
        <div class="my-1 flex items-center justify-between gap-1.5">
          <h3 class="font-extrabold text-sm text-slate-900 tracking-tight leading-snug truncate">${tbl.TenBan}</h3>
          ${isTabOpen ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-600 text-white shadow-xs shrink-0">Đang Mở</span>' : ''}
        </div>

        <!-- Hàng 3: Khu vực & Số ghế -->
        <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1.5 border-t border-slate-200/60 font-medium">
          <span class="truncate">${shortArea}</span>
          <span class="font-bold font-mono text-slate-700">${tbl.SoGhe} ghế</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.btn-floor-release-table').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tableId = btn.getAttribute('data-release-id');
      const tableName = btn.getAttribute('data-release-name');
      if (confirm(`Bạn có chắc chắn muốn đóng ${tableName} và chuyển về trạng thái BÀN TRỐNG không?`)) {
        await quickReleaseTable(tableId, tableName);
      }
    });
  });

  container.querySelectorAll('.floor-table-card').forEach(el => {
    el.addEventListener('click', () => {
      const tableId = el.getAttribute('data-table-id');
      openTableTab(tableId);
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// =====================================================================================
// MENU CATEGORIES & ITEMS RENDERING
// =====================================================================================
function renderCategories() {
  const container = document.getElementById('menu-categories-container');
  if (!container) return;

  let html = `<button class="cat-btn shrink-0 px-3.5 py-1.5 rounded-xl text-xs font-bold transition ${AppState.activeCategory === 'all' ? 'bg-amber-600 text-white shadow-xs' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'}" data-cat="all">Tất cả món</button>`;
  AppState.menuGroups.forEach(g => {
    const isActive = AppState.activeCategory === g.MaNhom;
    html += `<button class="cat-btn shrink-0 px-3.5 py-1.5 rounded-xl text-xs font-bold transition ${isActive ? 'bg-amber-600 text-white shadow-xs' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'}" data-cat="${g.MaNhom}">${g.TenNhom}</button>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.activeCategory = btn.getAttribute('data-cat');
      renderCategories();
      renderMenuItems();
      const menuGrid = document.getElementById('menu-items-grid');
      if (menuGrid) menuGrid.scrollTop = 0;
    });
  });
}

function renderMenuItems() {
  const container = document.getElementById('menu-items-grid');
  if (!container) return;

  const searchVal = (document.getElementById('menu-search-input')?.value || '').toLowerCase();

  const filtered = AppState.menuItems.filter(item => {
    const matchCat = AppState.activeCategory === 'all' || item.MaNhom === AppState.activeCategory;
    const matchSearch = item.TenMon.toLowerCase().includes(searchVal);
    return matchCat && matchSearch;
  });

  // Fallback SVG nếu hình ảnh từ internet không tải được
  const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='150' viewBox='0 0 200 150' fill='%23fef3c7'><rect width='200' height='150' fill='%23fef3c7'/><circle cx='100' cy='65' r='32' fill='%23d97706'/><text x='100' y='75' font-size='26' fill='%23ffffff' text-anchor='middle'>☕</text><text x='100' y='125' font-size='12' fill='%2392400e' font-weight='bold' text-anchor='middle'>PHỐ XANH</text></svg>`;

  let html = '';
  const canManageMenu = AppState.currentRole === 'ChuQuan' || AppState.currentRole === 'QuanLy';

  filtered.forEach(item => {
    const isAvailable = item.is_available !== false && item.DangKinhDoanh !== 0;
    const cardClass = isAvailable
      ? 'menu-item-card group hover-lift bg-white hover:border-amber-400 border border-slate-200 rounded-2xl p-3 flex flex-col justify-between cursor-pointer transition shadow-xs relative'
      : 'menu-item-card group bg-slate-100/90 border border-slate-300 rounded-2xl p-3 flex flex-col justify-between transition shadow-xs relative opacity-60 grayscale select-none cursor-not-allowed';

    html += `
      <div class="${cardClass}" data-item-id="${item.MaMon}" data-available="${isAvailable}">
        <!-- Ảnh món chất lượng cao (High-Res Food Photo với Fallback an toàn) -->
        <div class="relative w-full h-32 rounded-xl overflow-hidden mb-2.5 bg-slate-100 border border-slate-100">
          <img src="${item.HinhAnh}" alt="${item.TenMon}" loading="lazy" class="w-full h-full object-cover transition-transform duration-300 ${isAvailable ? 'group-hover:scale-105' : ''}" onerror="this.onerror=null; this.src='${fallbackSvg}';">
          <span class="absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/90 backdrop-blur-xs text-amber-800 shadow-xs border border-white/40 z-20">${item.DonViTinh}</span>

          <!-- Nhãn báo tạm hết món (86'd Items) -->
          ${!isAvailable ? `
            <div class="absolute inset-0 bg-slate-900/65 backdrop-blur-[1px] flex flex-col items-center justify-center text-white z-10 p-2 text-center">
              <span class="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-extrabold text-[11px] shadow-sm tracking-wide flex items-center gap-1">
                🚫 TẠM HẾT
              </span>
              <span class="text-[9.5px] text-slate-200 mt-0.5 font-medium">Bếp ngưng nhận món</span>
            </div>
          ` : ''}

          ${canManageMenu ? `
            <button type="button" class="btn-edit-dish absolute top-2 left-2 px-1.5 py-0.5 rounded-lg bg-white/90 hover:bg-white text-slate-700 text-[10px] font-bold shadow-xs border border-slate-200 transition opacity-0 group-hover:opacity-100 flex items-center gap-1 cursor-pointer z-20" data-id="${item.MaMon}" title="Sửa thông tin hoặc ảnh món">
              ✏️ Sửa
            </button>
          ` : ''}
        </div>
        
        <div class="flex-1 flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-1 flex-wrap">
              <h4 class="font-bold text-xs text-slate-900 ${isAvailable ? 'group-hover:text-amber-800' : 'text-slate-500'} transition line-clamp-1 leading-snug">${item.TenMon}</h4>
              ${!isAvailable ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-extrabold bg-rose-100 text-rose-700">Tạm hết</span>` : ''}
            </div>
          </div>
          <div class="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
            <span class="font-black text-xs text-amber-700 font-mono">${Number(item.GiaBanHienHanh).toLocaleString('vi-VN')} đ</span>
            ${isAvailable ? `
              <button class="w-6 h-6 rounded-lg bg-amber-600 hover:bg-amber-500 active:scale-90 text-white flex items-center justify-center text-xs font-bold shadow-xs transition cursor-pointer">+</button>
            ` : `
              <button class="w-6 h-6 rounded-lg bg-slate-300 text-slate-500 cursor-not-allowed text-xs font-bold" disabled title="Món này đang tạm hết">✕</button>
            `}
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.menu-item-card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-edit-dish')) return;
      const maMon = el.getAttribute('data-item-id');
      const item = AppState.menuItems.find(m => m.MaMon === maMon);
      const isAvailable = item && item.is_available !== false && item.DangKinhDoanh !== 0;
      if (!isAvailable) {
        showToast(`Món "${item ? item.TenMon : maMon}" đang TẠM HẾT! Bếp đã thông báo ngừng nhận món.`, 'warning');
        return;
      }
      addItemToCurrentTab(maMon);
    });
  });

  container.querySelectorAll('.btn-edit-dish').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      openMenuItemEditor(id);
    });
  });
}

// =====================================================================================
// ORDER & CART MANAGEMENT CHO TỪNG BÀN RIÊNG BIỆT
// =====================================================================================
function getCurrentTab() {
  return AppState.posTabs.find(t => t.id === AppState.activePosTabId);
}

function addItemToCurrentTab(maMon) {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.id === 'floor') return;

  const item = AppState.menuItems.find(m => m.MaMon === maMon);
  if (!item) return;

  // Khóa không cho phép thêm vào giỏ nếu món đang tạm hết (86'd)
  const isAvailable = item.is_available !== false && item.DangKinhDoanh !== 0;
  if (!isAvailable) {
    showToast(`Món "${item.TenMon}" đang TẠM HẾT! Vui lòng chọn món khác.`, 'warning');
    return;
  }

  const existing = currentTab.cart.find(c => c.maMon === maMon && !c.ghiChuTopping);
  if (existing) {
    const currentQty = existing.quantity !== undefined ? existing.quantity : existing.soLuong;
    existing.quantity = currentQty + 1;
    existing.soLuong = existing.quantity;
    existing.kds_status = 'UNSENT'; // Có phần gọi thêm chưa gửi
  } else {
    currentTab.cart.push({
      maMon: item.MaMon,
      tenMon: item.TenMon,
      donGia: item.GiaBanHienHanh,
      soLuong: 1,
      quantity: 1,
      sent_quantity: 0,
      kds_status: 'UNSENT',
      ghiChuTopping: '',
      hinhAnh: item.HinhAnh
    });
  }

  renderTabCart();
  renderPosTableTabs();
  updateTabCartTotals();
  saveTabsToStorage();

  // Hiệu ứng nảy nhẹ nút giỏ hàng và thông báo toast
  const floatBtn = document.getElementById('btn-floating-pos-cart');
  if (floatBtn) {
    floatBtn.classList.remove('animate-bounce');
    void floatBtn.offsetWidth;
    floatBtn.classList.add('animate-bounce');
  }
  showToast(`Đã thêm "${item.TenMon}" vào phiếu gọi món!`, 'info');
}

function renderTabCart() {
  const currentTab = getCurrentTab();
  const container = document.getElementById('tab-cart-items-container');
  if (!container) return;

  if (!currentTab || currentTab.cart.length === 0) {
    const isOccupiedEmpty = currentTab && currentTab.type === 'table' && currentTab.status !== 'Trong';
    container.innerHTML = `
      <div class="text-center py-12 px-3 text-slate-400 text-xs flex flex-col items-center justify-center space-y-3">
        <div class="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200/70 flex items-center justify-center text-amber-700 text-2xl shadow-xs">☕</div>
        <div>
          <p class="font-bold text-slate-700 text-sm">Bàn này chưa có món nào.</p>
          ${isOccupiedEmpty ? `<p class="text-[11px] text-rose-600 mt-1 font-semibold">Trạng thái: ${currentTab.status === 'CoKhach' ? 'Có khách (Chưa có món)' : 'Đặt trước'}</p>` : '<p class="text-[11px] text-slate-400 mt-0.5">Chạm vào món bên trái để gọi đồ uống</p>'}
        </div>
        ${isOccupiedEmpty ? `
          <button id="btn-empty-cart-release" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition flex items-center gap-1.5 cursor-pointer">
            <i data-lucide="check-circle" class="w-4 h-4"></i> Đóng Bàn (Trả Về Bàn Trống)
          </button>
        ` : ''}
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    const emptyReleaseBtn = document.getElementById('btn-empty-cart-release');
    if (emptyReleaseBtn) {
      emptyReleaseBtn.addEventListener('click', releaseCurrentTable);
    }
    updateTabCartTotals();
    return;
  }

  let html = '';
  currentTab.cart.forEach((item, idx) => {
    const thanhTien = item.soLuong * item.donGia;
    const sentQty = item.sent_quantity || 0;
    const unsentQty = Math.max(0, (item.soLuong || 0) - sentQty);

    let statusBadge = '';
    if (sentQty === 0) {
      statusBadge = `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/80 px-1.5 py-0.5 rounded-md">⏳ Chờ gửi bếp</span>`;
    } else if (unsentQty === 0) {
      statusBadge = `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">✓ Đã gửi bếp (${sentQty})</span>`;
    } else {
      statusBadge = `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-md">✓ Đã gửi: ${sentQty} • <strong class="text-rose-600 font-bold">Gọi thêm: +${unsentQty}</strong></span>`;
    }

    html += `
      <div class="bg-white p-2.5 rounded-xl border border-slate-200 space-y-1.5 shadow-xs animate-item-in">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            ${item.hinhAnh ? `<img src="${item.hinhAnh}" class="w-8 h-8 rounded-lg object-cover shrink-0 border border-slate-100" onerror="this.style.display='none'">` : ''}
            <div class="min-w-0 flex-1">
              <span class="font-bold text-xs text-slate-900 truncate block">${item.tenMon}</span>
              ${statusBadge}
            </div>
          </div>
          <span class="font-mono font-bold text-xs text-amber-700 shrink-0">${Number(thanhTien).toLocaleString('vi-VN')} đ</span>
        </div>
        <div class="flex items-center justify-between text-xs">
          <div class="flex items-center gap-1.5">
            <button class="cart-qty-btn px-2 py-0.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-bold cursor-pointer" data-idx="${idx}" data-delta="-1">-</button>
            <span class="w-6 text-center font-bold font-mono text-slate-800">${item.soLuong}</span>
            <button class="cart-qty-btn px-2 py-0.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-bold cursor-pointer" data-idx="${idx}" data-delta="1">+</button>
          </div>
          <button class="cart-del-btn text-rose-500 hover:text-rose-700 text-[11px] font-semibold cursor-pointer" data-idx="${idx}">Xóa</button>
        </div>
        <input type="text" placeholder="Đá, đường, size, topping..." value="${item.ghiChuTopping || ''}" data-idx="${idx}" class="cart-note-input w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-700 focus:outline-none focus:border-amber-500 focus:bg-white" ${sentQty > 0 && unsentQty === 0 ? 'disabled title="Món đã gửi bếp không thể sửa trực tiếp ghi chú"' : ''}>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.cart-qty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      const delta = Number(btn.getAttribute('data-delta'));
      const item = currentTab.cart[idx];
      if (!item) return;

      const sentQty = item.sent_quantity || 0;

      if (delta > 0) {
        item.soLuong += 1;
        item.kds_status = 'UNSENT';
        renderTabCart();
        renderPosTableTabs();
        updateTabCartTotals();
        saveTabsToStorage();
        return;
      }

      // Giảm số lượng (delta < 0)
      if (item.soLuong > sentQty) {
        // Đang giảm bớt món gọi thêm chưa gửi
        item.soLuong -= 1;
        if (item.soLuong <= 0) {
          currentTab.cart.splice(idx, 1);
        } else if (item.soLuong === sentQty) {
          item.kds_status = 'SENT_TO_KDS';
        }
        renderTabCart();
        renderPosTableTabs();
        updateTabCartTotals();
        saveTabsToStorage();
      } else {
        // Đang muốn giảm món ĐÃ GỬI BẾP -> Bắt buộc yêu cầu quản lý phê duyệt hủy món
        requestCancelItem(idx);
      }
    });
  });

  container.querySelectorAll('.cart-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      const item = currentTab.cart[idx];
      if (!item) return;

      const sentQty = item.sent_quantity || 0;
      if (sentQty === 0) {
        // Món chưa gửi bếp -> Cho phép xóa tự do
        currentTab.cart.splice(idx, 1);
        renderTabCart();
        renderPosTableTabs();
        updateTabCartTotals();
        saveTabsToStorage();
      } else if (item.soLuong > sentQty) {
        // Đã gửi bếp một phần, chỉ muốn hủy các ly gọi thêm chưa gửi
        item.soLuong = sentQty;
        item.kds_status = 'SENT_TO_KDS';
        showToast(`Đã hủy các ly gọi thêm chưa gửi bếp của "${item.tenMon}".`, 'info');
        renderTabCart();
        renderPosTableTabs();
        updateTabCartTotals();
        saveTabsToStorage();
      } else {
        // Món đã gửi bếp -> Yêu cầu quản lý phê duyệt hủy món
        requestCancelItem(idx);
      }
    });
  });

  container.querySelectorAll('.cart-note-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.getAttribute('data-idx'));
      if (currentTab.cart[idx]) {
        currentTab.cart[idx].ghiChuTopping = inp.value;
        saveTabsToStorage();
      }
    });
  });

  updateTabCartTotals();
}

function updateTabCartTotals() {
  const currentTab = getCurrentTab();
  if (!currentTab) return;

  let subtotal = 0;
  let totalQty = 0;
  currentTab.cart.forEach(item => {
    subtotal += item.donGia * item.soLuong;
    totalQty += item.soLuong;
  });

  let discount = 0;
  if (currentTab.customer && currentTab.customer.chietKhauPhanTram) {
    discount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
  }

  const total = Math.max(0, subtotal - discount);

  const subtotalEl = document.getElementById('tab-cart-subtotal');
  if (subtotalEl) subtotalEl.textContent = `${subtotal.toLocaleString('vi-VN')} đ`;
  const discEl = document.getElementById('tab-cart-discount');
  if (discEl) discEl.textContent = `-${discount.toLocaleString('vi-VN')} đ`;
  const totalEl = document.getElementById('tab-cart-total');
  if (totalEl) totalEl.textContent = `${total.toLocaleString('vi-VN')} đ`;

  // Cập nhật số lượng và tổng tiền trên nút Header bàn và Nút nổi giỏ hàng
  const headerBadge = document.getElementById('header-cart-badge');
  if (headerBadge) headerBadge.textContent = totalQty;
  const headerTotal = document.getElementById('header-cart-total');
  if (headerTotal) headerTotal.textContent = `${total.toLocaleString('vi-VN')} đ`;

  const floatBadge = document.getElementById('floating-cart-badge');
  if (floatBadge) floatBadge.textContent = totalQty;
  const floatTotal = document.getElementById('floating-cart-total');
  if (floatTotal) floatTotal.textContent = `${total.toLocaleString('vi-VN')} đ`;

  const floatBtn = document.getElementById('btn-floating-pos-cart');
  if (floatBtn) {
    if (!currentTab || currentTab.id === 'floor' || currentTab.type === 'floor') {
      floatBtn.classList.add('hidden');
    } else {
      floatBtn.classList.remove('hidden');
    }
  }

  // Cập nhật số lượng và tổng tiền trên Mobile Navigation & Bottom Bar
  const badgeEl = document.getElementById('mobile-cart-count-badge');
  if (badgeEl) badgeEl.textContent = totalQty;
  const barQtyEl = document.getElementById('mobile-bar-qty');
  if (barQtyEl) barQtyEl.textContent = totalQty;
  const barTotalEl = document.getElementById('mobile-bar-total');
  if (barTotalEl) barTotalEl.textContent = `${total.toLocaleString('vi-VN')} đ`;

  const mobileBar = document.getElementById('mobile-cart-bottom-bar');
  if (mobileBar) {
    if (totalQty > 0) {
      mobileBar.classList.remove('hidden');
    } else {
      mobileBar.classList.add('hidden');
    }
  }
}

// =====================================================================================
// THANH TOÁN (CHECKOUT) CHO BÀN HIỆN TẠI (VOUCHER, TÍCH ĐIỂM, MOMO, VNPAY - HÌNH 1 RBAC)
// =====================================================================================
// selectedPayMethod defined at top
// currentVoucher defined at top
// pendingCancelItem defined at top

function requestCancelItem(idx) {
  const currentTab = getCurrentTab();
  if (!currentTab || !currentTab.cart[idx]) return;
  const item = currentTab.cart[idx];

  // Pha Chế tuyệt đối không được phép thao tác xóa hoặc hủy món
  if (AppState.currentRole === 'PhaChe') {
    showToast('⛔ Pha Chế (Barista) không có thẩm quyền xóa hoặc hủy món trên hóa đơn!', 'error');
    return;
  }

  pendingCancelItem = {
    idx,
    item,
    tableId: currentTab.tableId,
    tableName: currentTab.tableName,
    orderCode: currentTab.activeOrderId || currentTab.currentOrderCode
  };

  // Mở modal yêu cầu phê duyệt hủy món (RBAC Audit: Chủ Quán / Quản Lý / Thu Ngân)
  const modal = document.getElementById('modal-cancel-approval');
  const itemNameEl = document.getElementById('cancel-item-name');
  const itemPriceEl = document.getElementById('cancel-item-price');
  const orderCodeEl = document.getElementById('cancel-order-code');
  const approverSelect = document.getElementById('cancel-approver-select');
  const pinInput = document.getElementById('cancel-approver-pin');

  if (itemNameEl) itemNameEl.textContent = `${item.tenMon} (x${item.soLuong})`;
  if (itemPriceEl) itemPriceEl.textContent = `${Number(item.soLuong * item.donGia).toLocaleString('vi-VN')} đ`;
  if (orderCodeEl) orderCodeEl.textContent = `${currentTab.tableName} • ${pendingCancelItem.orderCode}`;

  // Tự động chọn người duyệt phù hợp với vai trò đang trực
  if (approverSelect) {
    if (AppState.currentRole === 'ChuQuan') approverSelect.value = 'NV01';
    else if (AppState.currentRole === 'ThuNgan') approverSelect.value = 'NV03';
    else approverSelect.value = 'NV02';
  }

  if (pinInput) pinInput.value = '1234';
  if (modal) modal.classList.remove('hidden');
}

async function confirmCancelWithApproval() {
  const currentTab = getCurrentTab();
  if (!currentTab || !pendingCancelItem) return;

  const item = pendingCancelItem.item;
  const idx = pendingCancelItem.idx;
  const reason = document.getElementById('cancel-reason-select')?.value || 'KhachDoiY';
  const approverSelect = document.getElementById('cancel-approver-select');
  const pinInput = document.getElementById('cancel-approver-pin');

  const approverId = approverSelect?.value || 'NV02';
  const selectedOption = approverSelect?.options[approverSelect.selectedIndex];
  const approverRole = selectedOption?.getAttribute('data-role') || 'QuanLy';
  const approverTitle = selectedOption?.textContent.trim() || 'Quản Lý';
  const pin = pinInput?.value?.trim();

  // Xác thực mã PIN duyệt hủy (chấp nhận 1234 hoặc 123456)
  if (pin !== '1234' && pin !== '123456') {
    showToast('Mã PIN xác thực quyền duyệt không đúng! Gợi ý: 1234 (hoặc 123456)', 'error');
    pinInput?.focus();
    return;
  }

  const btnConfirm = document.getElementById('btn-confirm-cancel-by-manager');
  if (btnConfirm) btnConfirm.disabled = true;

  try {
    // Gửi bản ghi phê duyệt hủy món lên Server lưu vào CSDL (YEU_CAU_HUY_DOI_MON)
    const res = await fetch('/api/orders/cancel-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        soHoaDon: currentTab.activeOrderId || currentTab.currentOrderCode,
        tenMon: item.tenMon,
        soLuong: item.soLuong,
        donGia: item.donGia,
        lyDoHuy: reason,
        nguoiYeuCau: AppState.currentUser?.maNhanVien || 'NV03',
        nguoiPheDuyet: approverId,
        vaiTroPheDuyet: approverRole
      })
    });
    const result = await res.json();
    if (result.success) {
      currentTab.cart.splice(idx, 1);
      pendingCancelItem = null;
      renderTabCart();
      renderPosTableTabs();
      document.getElementById('modal-cancel-approval')?.classList.add('hidden');
      showToast(`🛡️ ${approverTitle} ĐÃ PHÊ DUYỆT HỦY MÓN "${item.tenMon}"!`, 'success');
    } else {
      showToast(`Lỗi phê duyệt: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi hệ thống: ${err.message}`, 'error');
  } finally {
    if (btnConfirm) btnConfirm.disabled = false;
  }
}

function applyVoucherCode(code) {
  const currentTab = getCurrentTab();
  if (!currentTab) return;

  let subtotal = 0;
  currentTab.cart.forEach(i => subtotal += i.donGia * i.soLuong);

  code = (code || '').trim().toUpperCase();
  if (code === 'PHOXANH10') {
    currentVoucher = { code, discount: Math.round(subtotal * 0.1) };
  } else if (code === 'GIAM20K') {
    currentVoucher = { code, discount: Math.min(20000, subtotal) };
  } else if (code === 'VIP30') {
    currentVoucher = { code, discount: Math.round(subtotal * 0.3) };
  } else {
    showToast(`Mã voucher "${code}" không hợp lệ hoặc đã hết hạn!`, 'warning');
    return;
  }

  showToast(`Đã áp dụng voucher ${code}: giảm ${currentVoucher.discount.toLocaleString('vi-VN')} đ!`, 'success');
  updateCheckoutModalAmounts();
}

function updateCheckoutModalAmounts() {
  const currentTab = getCurrentTab();
  if (!currentTab) return;

  let subtotal = 0;
  currentTab.cart.forEach(i => subtotal += i.donGia * i.soLuong);

  let memberDiscount = 0;
  if (currentTab.customer && currentTab.customer.chietKhauPhanTram) {
    memberDiscount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
  }

  let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
  const total = Math.max(0, subtotal - memberDiscount - voucherDiscount);

  document.getElementById('modal-pay-amount').textContent = `${total.toLocaleString('vi-VN')} đ`;

  const voucherRow = document.getElementById('voucher-discount-row');
  const voucherVal = document.getElementById('voucher-discount-val');
  const voucherBadge = document.getElementById('voucher-status-badge');
  if (currentVoucher) {
    voucherRow?.classList.remove('hidden');
    if (voucherVal) voucherVal.textContent = `-${currentVoucher.discount.toLocaleString('vi-VN')} đ (${currentVoucher.code})`;
    voucherBadge?.classList.remove('hidden');
  } else {
    voucherRow?.classList.add('hidden');
    voucherBadge?.classList.add('hidden');
  }

  const inputGiven = document.getElementById('input-cash-given');
  if (inputGiven) inputGiven.value = total;
  calculateChange();

  updatePaymentGatewayQr(total);
}

function updatePaymentGatewayQr(total) {
  const qrImg = document.getElementById('vietqr-image');
  const qrBox = document.getElementById('qr-display-box');
  const cashBox = document.getElementById('cash-calculation-box');

  if (selectedPayMethod === 'TienMat') {
    cashBox?.classList.remove('hidden');
    qrBox?.classList.add('hidden');
  } else {
    cashBox?.classList.add('hidden');
    qrBox?.classList.remove('hidden');

    if (qrImg) {
      if (selectedPayMethod === 'MoMo') {
        qrImg.src = `https://api.vietqr.io/image/970422-0901234567-compact.png?amount=${total}&addInfo=MOMO_CAFE_${Date.now().toString().slice(-4)}`;
      } else if (selectedPayMethod === 'VNPay') {
        qrImg.src = `https://api.vietqr.io/image/970422-0901234567-compact.png?amount=${total}&addInfo=VNPAY_CAFE_${Date.now().toString().slice(-4)}`;
      } else {
        qrImg.src = `https://api.vietqr.io/image/970422-0901234567-compact.png?amount=${total}&addInfo=CAFE_${Date.now().toString().slice(-4)}`;
      }
    }
  }
}

function openCheckoutModalForCurrentTab() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.cart.length === 0) {
    if (currentTab && currentTab.type === 'table') {
      const confirmClose = confirm(`${currentTab.tableName} hiện không có món nào để thanh toán.\n\nBạn có muốn ĐÓNG BÀN và chuyển về trạng thái BÀN TRỐNG ngay bây giờ không?`);
      if (confirmClose) {
        releaseCurrentTable();
      }
      return;
    }
    showToast('Đơn này chưa chọn món nào!', 'warning');
    return;
  }

  currentVoucher = null;
  const voucherInp = document.getElementById('input-voucher-code');
  if (voucherInp) voucherInp.value = '';

  document.getElementById('modal-pay-table').textContent = currentTab.tableName;
  document.getElementById('modal-pay-cust').textContent = currentTab.customer ? `${currentTab.customer.HoTen} (${currentTab.customer.HangThanhVien})` : 'Khách vãng lai';

  updateCheckoutModalAmounts();

  document.getElementById('modal-checkout').classList.remove('hidden');
}

function calculateChange() {
  const currentTab = getCurrentTab();
  if (!currentTab) return;

  let subtotal = 0;
  currentTab.cart.forEach(i => subtotal += i.donGia * i.soLuong);
  let discount = 0;
  if (currentTab.customer && currentTab.customer.chietKhauPhanTram) {
    discount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
  }
  let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
  const total = Math.max(0, subtotal - discount - voucherDiscount);

  const given = Number(document.getElementById('input-cash-given')?.value || 0);
  const change = Math.max(0, given - total);
  document.getElementById('cash-change-return').textContent = `${change.toLocaleString('vi-VN')} đ`;
}

async function submitCurrentTabPayment() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.cart.length === 0) return;

  const btn = document.getElementById('btn-submit-payment');
  btn.disabled = true;
  btn.textContent = 'Đang xử lý trừ kho & in bill...';

  try {
    if (AppState.isSimulatedOffline) {
      let subtotal = 0;
      currentTab.cart.forEach(i => subtotal += i.donGia * i.soLuong);
      const orderDto = {
        kenhDatHang: currentTab.type === 'takeaway' ? 'MangDi' : 'TaiBan',
        maBan: currentTab.type === 'takeaway' ? null : currentTab.tableId,
        maNhanVien: AppState.currentUser.maNhanVien,
        maKhachHang: currentTab.customer?.MaKhachHang || null,
        items: currentTab.cart.map(c => ({
          maMon: c.maMon,
          soLuong: c.soLuong,
          donGia: c.donGia,
          ghiChuTopping: c.ghiChuTopping
        })),
        giamGia: 0,
        phuongThucThanhToan: selectedPayMethod,
        thanhToanNgay: true
      };
      await window.OfflineDB.saveOrderOffline(orderDto);
      showToast('Đang Ngoại Tuyến: Đã lưu đơn hàng vào thiết bị (Offline Mode)!', 'warning');
      completeOrderFlow('HD_OFFLINE_' + Date.now());
    } else if (currentTab.activeOrderId) {
      // Nếu có món gọi thêm chưa kịp bấm Gửi Bếp mà bấm Thanh Toán: tự động đồng bộ món vào hóa đơn trước khi chốt tiền
      const unsentItems = currentTab.cart
        .filter(c => (c.soLuong - (c.sent_quantity || 0)) > 0)
        .map(c => ({
          maMon: c.maMon,
          soLuong: c.soLuong - (c.sent_quantity || 0),
          donGia: c.donGia,
          ghiChuTopping: c.ghiChuTopping || ''
        }));

      if (unsentItems.length > 0) {
        await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            soHoaDon: currentTab.activeOrderId,
            kenhDatHang: currentTab.type === 'takeaway' ? 'MangDi' : 'TaiBan',
            maBan: currentTab.type === 'takeaway' ? null : currentTab.tableId,
            maNhanVien: AppState.currentUser?.maNhanVien || 'NV03',
            items: unsentItems,
            isAddOn: true
          })
        });
      }

      // Hóa đơn đã được tạo khi Gửi Bếp: gọi endpoint thanh toán /api/orders/:id/pay
      const res = await fetch(`/api/orders/${currentTab.activeOrderId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phuongThucThanhToan: selectedPayMethod,
          maNhanVien: AppState.currentUser.maNhanVien
        })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.message);

      showToast(`Đã thanh toán thành công hóa đơn ${currentTab.activeOrderId}!`, 'success');
      completeOrderFlow(currentTab.activeOrderId);

      if (result.lowStockAlerts && result.lowStockAlerts.length > 0) {
        result.lowStockAlerts.forEach(a => handleStockAlert(a));
      }
    } else {
      let subtotal = 0;
      currentTab.cart.forEach(i => subtotal += i.donGia * i.soLuong);
      let memberDiscount = 0;
      if (currentTab.customer && currentTab.customer.chietKhauPhanTram) {
        memberDiscount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
      }
      let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
      const totalDiscount = memberDiscount + voucherDiscount;

      const orderDto = {
        kenhDatHang: currentTab.type === 'takeaway' ? 'MangDi' : 'TaiBan',
        maBan: currentTab.type === 'takeaway' ? null : currentTab.tableId,
        maNhanVien: AppState.currentUser.maNhanVien,
        maKhachHang: currentTab.customer?.MaKhachHang || null,
        items: currentTab.cart.map(c => ({
          maMon: c.maMon,
          soLuong: c.soLuong,
          donGia: c.donGia,
          ghiChuTopping: c.ghiChuTopping
        })),
        giamGia: totalDiscount,
        ghiChu: currentVoucher ? `Áp dụng Voucher: ${currentVoucher.code}` : undefined,
        phuongThucThanhToan: selectedPayMethod,
        thanhToanNgay: true
      };

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderDto)
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.message);

      showToast(`Đã thanh toán thành công hóa đơn ${result.data.soHoaDon}!`, 'success');
      completeOrderFlow(result.data.soHoaDon);

      if (result.lowStockAlerts && result.lowStockAlerts.length > 0) {
        result.lowStockAlerts.forEach(a => handleStockAlert(a));
      }
    }
  } catch (err) {
    showToast(`Lỗi thanh toán: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'HOÀN TẤT THANH TOÁN & TRỪ KHO TỰ ĐỘNG';
    document.getElementById('modal-checkout').classList.add('hidden');
  }
}

async function completeOrderFlow(soHoaDon) {
  triggerDrawerKickPulse();
  await fetchAndPreviewReceipt(soHoaDon);

  // Tự động in hóa đơn nếu checkbox in tự động được tích
  const autoPrintCheckbox = document.getElementById('check-auto-print');
  if (autoPrintCheckbox && autoPrintCheckbox.checked) {
    setTimeout(() => {
      printReceipt();
    }, 250);
  }

  // Xóa giỏ hàng của bàn và đóng tab này hoặc đặt lại trống
  const currentTab = getCurrentTab();
  if (currentTab) {
    currentTab.cart = [];
    currentTab.customer = null;
    currentTab.activeOrderId = null;
    closePosTab(currentTab.id);
  }

  loadTables();
  loadShiftData();
  loadProfitAndLoss();
  loadStaffData();
  loadKdsTickets();
}

// In tạm tính cho bàn (Chỉ in riêng phiếu tạm tính, không in cả trang web)
async function quickPrintBill() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.cart.length === 0) {
    showToast('Bàn này chưa chọn món nào để in tạm tính!', 'warning');
    return;
  }

  let text = '               CÀ PHÊ PHỐ XANH                  \n';
  text += '    123 Nguyễn Trãi, Q.1, TP. Hồ Chí Minh       \n';
  text += '              Hotline: 0901.234.567             \n';
  text += '================================================\n';
  text += `PHIẾU TẠM TÍNH: ${currentTab.tableName}\n`;
  text += `Giờ in: ${new Date().toLocaleTimeString('vi-VN')} - ${new Date().toLocaleDateString('vi-VN')}\n`;
  text += `Thu ngân: ${AppState.currentUser?.hoTen || 'Lê Thị Mai'}\n`;
  if (currentTab.customer) {
    text += `Khách hàng: ${currentTab.customer.HoTen} (${currentTab.customer.HangThanhVien || 'Member'})\n`;
  }
  text += '------------------------------------------------\n';
  text += 'TÊN MÓN            SL   ĐƠN GIÁ       THÀNH TIỀN\n';
  text += '------------------------------------------------\n';

  let subtotal = 0;
  currentTab.cart.forEach(item => {
    const tt = item.soLuong * item.donGia;
    subtotal += tt;
    const ten = item.tenMon.padEnd(18, ' ').substring(0, 18);
    const sl = String(item.soLuong).padStart(3, ' ');
    const dg = Number(item.donGia).toLocaleString('vi-VN').padStart(9, ' ');
    const ttStr = Number(tt).toLocaleString('vi-VN').padStart(14, ' ');
    text += `${ten} ${sl} ${dg} ${ttStr}\n`;
    if (item.ghiChuTopping) {
      text += `  * ${item.ghiChuTopping}\n`;
    }
  });

  text += '------------------------------------------------\n';
  let memberDiscount = 0;
  if (currentTab.customer && currentTab.customer.chietKhauPhanTram) {
    memberDiscount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
  }
  let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
  const totalDiscount = memberDiscount + voucherDiscount;
  if (totalDiscount > 0) {
    text += `Tổng tiền món: ${Number(subtotal).toLocaleString('vi-VN').padStart(29, ' ')} đ\n`;
    text += `Giảm giá:      ${Number(totalDiscount).toLocaleString('vi-VN').padStart(29, ' ')} đ\n`;
    text += `CẦN THANH TOÁN:${Number(subtotal - totalDiscount).toLocaleString('vi-VN').padStart(29, ' ')} đ\n`;
  } else {
    text += `TỔNG CỘNG:     ${Number(subtotal).toLocaleString('vi-VN').padStart(29, ' ')} đ\n`;
  }
  text += '================================================\n';
  text += '          XIN QUÝ KHÁCH KIỂM TRA LẠI!           \n\n';

  const preview = document.getElementById('receipt-text-preview');
  if (preview) preview.textContent = text;

  // Gọi in hóa đơn nhiệt trực tiếp
  printReceipt(text);
  showToast(`Đã xuất lệnh in phiếu tạm tính cho ${currentTab.tableName}!`, 'success');
}

// Chuyển bàn / Đổi bàn
function openTransferTableModal() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.type === 'takeaway') {
    showToast('Chỉ hỗ trợ chuyển bàn đối với các bàn phục vụ tại quán!', 'warning');
    return;
  }

  document.getElementById('transfer-from-table-display').value = `${currentTab.tableName} (${currentTab.areaName})`;

  const selectTo = document.getElementById('select-transfer-to-table');
  const availableTables = AppState.tables.filter(t => t.MaBan !== currentTab.tableId && t.TrangThai === 'Trong');

  let html = '';
  availableTables.forEach(t => {
    html += `<option value="${t.MaBan}">${t.TenBan} (${t.TenKhuVuc} - ${t.SoGhe} ghế)</option>`;
  });

  selectTo.innerHTML = html;
  document.getElementById('modal-transfer-table').classList.remove('hidden');
}

async function confirmTableTransfer() {
  const currentTab = getCurrentTab();
  const toTableId = document.getElementById('select-transfer-to-table')?.value;
  if (!currentTab || !toTableId) return;

  try {
    const res = await fetch('/api/tables/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromTable: currentTab.tableId,
        toTable: toTableId
      })
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.message, 'success');
      // Đổi tên tab hiện tại thành bàn mới
      const newTable = AppState.tables.find(t => t.MaBan === toTableId);
      currentTab.tableId = toTableId;
      currentTab.title = newTable ? newTable.TenBan : `Bàn ${toTableId}`;
      currentTab.tableName = newTable ? newTable.TenBan : `Bàn ${toTableId}`;
      currentTab.id = `table_${toTableId}`;
      AppState.activePosTabId = currentTab.id;

      document.getElementById('modal-transfer-table').classList.add('hidden');
      renderPosTableTabs();
      renderCurrentTabDetail();
      loadTables();
    } else {
      showToast(`Lỗi: ${result.message}`, 'error');
    }
  } catch (e) {
    showToast('Lỗi khi chuyển bàn', 'error');
  }
}

// Ghép bàn / Gộp hóa đơn (Merge Tables)
function openMergeTableModal() {
  const currentTab = getCurrentTab();
  if (!currentTab || currentTab.type === 'takeaway') {
    showToast('Chỉ hỗ trợ ghép bàn đối với các bàn phục vụ tại quán!', 'warning');
    return;
  }

  const fromDisplay = document.getElementById('merge-from-table-display');
  if (fromDisplay) fromDisplay.value = `${currentTab.tableName} (${currentTab.areaName || 'Khu vực'})`;

  const selectTo = document.getElementById('select-merge-to-table');
  const otherTables = AppState.tables.filter(t => t.MaBan !== currentTab.tableId);

  let html = '';
  otherTables.forEach(t => {
    const statusText = t.TrangThai === 'CoKhach' ? 'Đang có khách' : 'Trống';
    html += `<option value="${t.MaBan}">${t.TenBan} (${t.TenKhuVuc} - ${statusText})</option>`;
  });

  if (selectTo) selectTo.innerHTML = html;
  document.getElementById('modal-merge-table')?.classList.remove('hidden');
}

async function confirmTableMerge() {
  const currentTab = getCurrentTab();
  const toTableId = document.getElementById('select-merge-to-table')?.value;
  if (!currentTab || !toTableId) return;

  const btnConfirm = document.getElementById('btn-confirm-merge');
  if (btnConfirm) btnConfirm.disabled = true;

  try {
    const res = await fetch('/api/tables/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AppState.token || ''}`
      },
      body: JSON.stringify({
        fromTableId: currentTab.tableId,
        toTableId: toTableId
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Ghép bàn thành công!', 'success');
      document.getElementById('modal-merge-table')?.classList.add('hidden');
      closeTableTab(currentTab.id);
      await loadTables();
      await loadOrders();
      renderFloorTables();
    } else {
      showToast(data.message || 'Ghép bàn thất bại!', 'error');
    }
  } catch (err) {
    console.error('Lỗi khi ghép bàn:', err);
    showToast('Có lỗi xảy ra khi ghép bàn!', 'error');
  } finally {
    if (btnConfirm) btnConfirm.disabled = false;
  }
}

// =====================================================================================
// KDS TICKETS RENDERING & STABLE REAL-TIME UPDATES (KHÔNG GIẬT LAG)
// =====================================================================================
let kdsReloadTimer = null;
function scheduleKdsTicketsReload(delay = 100) {
  if (kdsReloadTimer) {
    clearTimeout(kdsReloadTimer);
  }
  kdsReloadTimer = setTimeout(() => {
    kdsReloadTimer = null;
    loadKdsTickets();
  }, delay);
}

function renderKdsTickets() {
  const container = document.getElementById('kds-tickets-container');
  if (!container) return;

  if (AppState.kdsTickets.length === 0) {
    container.innerHTML = `
      <div class="w-full text-center py-24 text-slate-400 text-sm">
        <div class="text-4xl mb-3 opacity-30">☕</div>
        Hiện không có đơn nào đang chờ pha chế.<br>Tất cả đồ uống đã hoàn tất!
      </div>
    `;
    return;
  }

  let html = '';
  AppState.kdsTickets.forEach(ticket => {
    const ticketTime = ticket.created_at || ticket.thoiGianGuiBep || ticket.ThoiGianGuiBepRound || ticket.NgayGioLap;
    const isAddOn = Boolean(ticket.isAddOn || (ticket.lanGoi && ticket.lanGoi > 1));
    const addOnBadgeHtml = isAddOn
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black bg-rose-600 text-white shadow-xs animate-pulse">🛎️ GỌI THÊM (ĐỢT ${ticket.lanGoi})</span>`
      : '';

    let itemsHtml = '';
    (ticket.items || []).forEach(it => {
      let statusBtn = '';
      if (it.TrangThaiPhaChe === 'ChoLam') {
        statusBtn = `<button type="button" class="kds-status-btn px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-50 text-amber-800 border border-amber-300 hover:bg-amber-600 hover:text-white transition-colors cursor-pointer shadow-2xs" data-id="${it.MaChiTiet}" data-next="DangLam" title="Bấm để chuyển sang Đang làm">⏳ Chờ làm</button>`;
      } else if (it.TrangThaiPhaChe === 'DangLam') {
        statusBtn = `<button type="button" class="kds-status-btn px-2.5 py-1.5 rounded-lg text-xs font-bold bg-sky-50 text-sky-800 border border-sky-300 hover:bg-sky-600 hover:text-white transition-colors cursor-pointer shadow-2xs" data-id="${it.MaChiTiet}" data-next="HoanThanh" title="Bấm để hoàn tất món này">🔄 Đang làm</button>`;
      } else {
        statusBtn = `<span class="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 inline-block shadow-2xs">✅ Đã xong</span>`;
      }

      itemsHtml += `
        <div class="p-2.5 rounded-xl bg-slate-50/90 border border-slate-200/80 flex items-center justify-between gap-2 transition-colors">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="w-6 h-6 rounded-md bg-amber-600 text-white font-mono font-black flex items-center justify-center text-xs shadow-xs shrink-0">${it.SoLuong}</span>
              <span class="font-bold text-xs text-slate-900 truncate">${it.TenMon}</span>
              <button type="button" class="btn-quick-86 px-1.5 py-0.5 rounded text-[10px] text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition font-semibold cursor-pointer shrink-0" data-dish-id="${it.MaMon}" data-dish-name="${it.TenMon}" title="Báo tạm hết món này (86)">🚫 Hết</button>
            </div>
            ${it.GhiChuTopping ? `<span class="text-[11px] text-amber-700 block ml-8 italic truncate">📝 ${it.GhiChuTopping}</span>` : ''}
          </div>
          <div class="shrink-0">${statusBtn}</div>
        </div>
      `;
    });

    html += `
      <div class="kds-card min-w-[340px] max-w-[340px] bg-white border border-slate-200/90 hover:border-amber-400 rounded-2xl p-4 flex flex-col justify-between shadow-xs transition-all duration-300 relative overflow-hidden select-none"
           id="kds-card-${ticket.ticketId}"
           data-ticket-id="${ticket.ticketId}"
           data-created-at="${ticketTime}">
        <div class="kds-card-bar absolute top-0 left-0 right-0 h-1.5 transition-colors duration-300 bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600"></div>
        <div>
          <div class="flex items-center justify-between border-b border-slate-100 pb-2.5 mb-3 pt-1 gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-mono font-bold text-amber-700">${ticket.ticketId || ticket.SoHoaDon}</span>
                ${addOnBadgeHtml}
              </div>
              <h3 class="text-sm font-extrabold text-slate-900 truncate">${ticket.TenBan || 'Đơn Mang Đi'}</h3>
            </div>
            <!-- SLA Timer: Hiển thị mm:ss, đổi màu vàng >5p, đỏ >10p -->
            <div class="kds-sla-container shrink-0 text-right">
              <span class="kds-sla-badge inline-flex items-center gap-1 font-mono font-semibold text-xs px-2 py-0.5 rounded-lg border transition-all duration-300 bg-slate-100 text-slate-700 border-slate-200 shadow-2xs">
                ⏱️ 00:00
              </span>
            </div>
          </div>
          <div class="space-y-2">
            ${itemsHtml}
          </div>
        </div>
        <div class="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
          <div class="text-[11px] text-slate-500">
            <span>Kênh: <strong class="text-slate-700">${ticket.KenhDatHang}</strong></span>
            <span class="font-mono text-slate-400 block">${new Date(ticketTime).toLocaleTimeString('vi-VN')}</span>
          </div>
          <button class="kds-complete-all-btn px-2.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs transition cursor-pointer flex items-center gap-1 shrink-0" data-order-id="${ticket.SoHoaDon || ticket.MaHoaDon}" data-lan-goi="${ticket.lanGoi || 1}" title="Hoàn tất toàn bộ các món trong phiếu này">
            <i data-lucide="check-check" class="w-3.5 h-3.5"></i> Hoàn Tất Đơn
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Lắng nghe sự kiện click nút hoàn tất cả đơn
  container.querySelectorAll('.kds-complete-all-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute('data-order-id');
      const lanGoi = btn.getAttribute('data-lan-goi');
      if (!orderId) return;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Đang xong...</span>';
      await completeEntireOrder(orderId, lanGoi);
    });
  });

  // Lắng nghe sự kiện click nút trạng thái pha chế với Optimistic UI mượt mà, chống giật rung
  container.querySelectorAll('.kds-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const itemId = btn.getAttribute('data-id');
      const nextStatus = btn.getAttribute('data-next');
      if (!itemId || !nextStatus) return;

      // Phản hồi giao diện tức thì để người dùng cảm thấy mượt, không bị chớp hay lag
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';
      if (nextStatus === 'DangLam') {
        btn.textContent = '🔄 Bắt đầu...';
      } else if (nextStatus === 'HoanThanh') {
        btn.textContent = '✅ Đang xong...';
      }

      await updateKdsItemStatus(itemId, nextStatus);
    });
  });

  // Lắng nghe sự kiện nút báo hết món nhanh (Quick 86) trên từng món KDS
  container.querySelectorAll('.btn-quick-86').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dishId = btn.getAttribute('data-dish-id');
      const dishName = btn.getAttribute('data-dish-name') || dishId;
      toggleDishAvailability(dishId, false);
    });
  });

  if (window.lucide) window.lucide.createIcons();

  // Khởi động đồng hồ đếm thời gian chờ SLA Timer cập nhật tức thời
  updateKdsSlaTimers();
  startKdsSlaTicker();
}

// =====================================================================================
// ĐỒNG HỒ ĐẾM THỜI GIAN CHỜ (SLA TIMER) TRÊN TỪNG PHIẾU KDS
// =====================================================================================
function startKdsSlaTicker() {
  if (kdsSlaInterval) clearInterval(kdsSlaInterval);
  kdsSlaInterval = setInterval(() => {
    updateKdsSlaTimers();
  }, 1000);
}

function updateKdsSlaTimers() {
  const cards = document.querySelectorAll('.kds-card');
  if (!cards || cards.length === 0) return;

  const now = Date.now();
  cards.forEach(card => {
    const createdAtStr = card.getAttribute('data-created-at');
    if (!createdAtStr) return;
    const createdAt = new Date(createdAtStr).getTime();
    if (isNaN(createdAt)) return;

    const elapsedSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
    const mins = Math.floor(elapsedSeconds / 60);
    const secs = elapsedSeconds % 60;
    const timeFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const badge = card.querySelector('.kds-sla-badge');
    const topBar = card.querySelector('.kds-card-bar');

    // Mức 3: Khẩn cấp - Chờ trên 10 phút (>= 600s) -> Đổi viền và nhãn sang màu ĐỎ nhấp nháy
    if (elapsedSeconds >= 600) {
      card.className = 'kds-card min-w-[340px] max-w-[340px] bg-white border-2 border-rose-500 ring-2 ring-rose-400/50 shadow-lg shadow-rose-100 rounded-2xl p-4 flex flex-col justify-between transition-all duration-300 relative overflow-hidden select-none';
      if (topBar) topBar.className = 'kds-card-bar absolute top-0 left-0 right-0 h-1.5 transition-colors duration-300 bg-rose-600';
      if (badge) {
        badge.className = 'kds-sla-badge inline-flex items-center gap-1 font-mono font-black text-xs px-2.5 py-0.5 rounded-lg bg-rose-600 text-white border border-rose-700 animate-pulse shadow-xs';
        badge.innerHTML = `🚨 ${timeFormatted} (>10p)`;
      }
    }
    // Mức 2: Cảnh báo - Chờ trên 5 phút (300s - 599s) -> Đổi viền và nhãn sang màu VÀNG
    else if (elapsedSeconds >= 300) {
      card.className = 'kds-card min-w-[340px] max-w-[340px] bg-white border-2 border-amber-400 ring-2 ring-amber-300/40 shadow-md shadow-amber-50 rounded-2xl p-4 flex flex-col justify-between transition-all duration-300 relative overflow-hidden select-none';
      if (topBar) topBar.className = 'kds-card-bar absolute top-0 left-0 right-0 h-1.5 transition-colors duration-300 bg-amber-400';
      if (badge) {
        badge.className = 'kds-sla-badge inline-flex items-center gap-1 font-mono font-bold text-xs px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 border border-amber-400 shadow-2xs';
        badge.innerHTML = `⚠️ ${timeFormatted} (>5p)`;
      }
    }
    // Mức 1: Bình thường (< 5 phút)
    else {
      card.className = 'kds-card min-w-[340px] max-w-[340px] bg-white border border-slate-200/90 hover:border-amber-400 rounded-2xl p-4 flex flex-col justify-between shadow-xs hover:shadow-md transition-all duration-300 relative overflow-hidden select-none';
      if (topBar) topBar.className = 'kds-card-bar absolute top-0 left-0 right-0 h-1.5 transition-colors duration-300 bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600';
      if (badge) {
        badge.className = 'kds-sla-badge inline-flex items-center gap-1 font-mono font-semibold text-xs px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 shadow-2xs';
        badge.innerHTML = `⏱️ ${timeFormatted}`;
      }
    }
  });
}

// =====================================================================================
// TÍNH NĂNG "BÁO HẾT MÓN" (86'D ITEMS) ĐỒNG BỘ HAI CHIỀU GIỮA KDS VÀ POS
// =====================================================================================
async function toggleDishAvailability(maMon, explicitStatus) {
  try {
    const dish = AppState.menuItems.find(m => m.MaMon === maMon);
    if (!dish) return;

    let nextAvailable = explicitStatus !== undefined 
      ? explicitStatus 
      : !(dish.is_available ?? (dish.DangKinhDoanh === 1));

    const res = await fetch(`/api/menu/items/${maMon}/toggle-stock`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_available: nextAvailable, dangKinhDoanh: nextAvailable ? 1 : 0 })
    });
    const data = await res.json();
    if (data.success) {
      dish.DangKinhDoanh = nextAvailable ? 1 : 0;
      dish.is_available = nextAvailable;
      renderMenuItems();
      renderKds86List();
      updateKds86Badge();
      if (!nextAvailable) {
        showToast(`🔴 Đã báo TẠM HẾT món "${dish.TenMon}"! POS đã khóa món này.`, 'warning');
      } else {
        showToast(`🟢 Đã mở bán trở lại món "${dish.TenMon}"!`, 'success');
      }
    } else {
      showToast(data.message || 'Lỗi cập nhật trạng thái món', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối khi cập nhật món: ' + err.message, 'error');
  }
}

function updateKds86Badge() {
  const outOfStockItems = AppState.menuItems.filter(m => m.is_available === false || m.DangKinhDoanh === 0);
  const badge = document.getElementById('kds-86-count-badge');
  const countEl = document.getElementById('kds-86-out-count');
  if (countEl) countEl.textContent = outOfStockItems.length;
  if (badge) {
    badge.textContent = outOfStockItems.length;
    if (outOfStockItems.length > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function openKds86Modal() {
  const modal = document.getElementById('modal-kds-86-management');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderKds86List();
  if (window.lucide) window.lucide.createIcons();
}

function closeKds86Modal() {
  const modal = document.getElementById('modal-kds-86-management');
  if (modal) modal.classList.add('hidden');
}

function renderKds86List() {
  const container = document.getElementById('kds-86-items-list');
  if (!container) return;

  const searchVal = (document.getElementById('kds-86-search-input')?.value || '').toLowerCase().trim();
  const filter = kds86ActiveFilter;

  let items = AppState.menuItems.filter(item => {
    const isAvail = item.is_available !== false && item.DangKinhDoanh !== 0;
    if (filter === 'out' && isAvail) return false;
    if (filter === 'available' && !isAvail) return false;
    if (searchVal) {
      return item.TenMon.toLowerCase().includes(searchVal) || item.MaMon.toLowerCase().includes(searchVal);
    }
    return true;
  });

  if (items.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 text-slate-400 text-xs">
        <p class="font-bold text-slate-600">Không tìm thấy món nào phù hợp</p>
      </div>
    `;
    return;
  }

  let html = '';
  items.forEach(item => {
    const isAvail = item.is_available !== false && item.DangKinhDoanh !== 0;
    html += `
      <div class="flex items-center justify-between p-2.5 rounded-2xl border transition-all ${isAvail ? 'bg-white border-slate-200' : 'bg-rose-50/60 border-rose-200'}">
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <img src="${item.HinhAnh || ''}" class="w-10 h-10 rounded-xl object-cover shrink-0 border border-slate-100 ${!isAvail ? 'grayscale opacity-70' : ''}" onerror="this.style.display='none'">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-xs text-slate-900 truncate">${item.TenMon}</span>
              ${!isAvail ? `<span class="px-1.5 py-0.2 rounded-md bg-rose-600 text-white font-extrabold text-[9px]">TẠM HẾT</span>` : ''}
            </div>
            <div class="flex items-center gap-2 text-[11px] text-slate-500">
              <span class="font-mono text-amber-700 font-bold">${Number(item.GiaBanHienHanh).toLocaleString('vi-VN')} đ</span>
              <span>•</span>
              <span class="font-mono text-slate-400">${item.MaMon}</span>
            </div>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-2">
          <button type="button" class="btn-toggle-86-switch px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shadow-xs ${isAvail ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300' : 'bg-rose-600 text-white hover:bg-emerald-600'}" data-dish-id="${item.MaMon}">
            ${isAvail ? '<i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i> Đang bán' : '<i data-lucide="ban" class="w-3.5 h-3.5"></i> Báo hết (86)'}
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateKds86Badge();

  container.querySelectorAll('.btn-toggle-86-switch').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-dish-id');
      toggleDishAvailability(id);
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

async function completeEntireOrder(orderId, lanGoi) {
  try {
    const url = `/api/orders/kds/${orderId}/complete-all${lanGoi ? `?lanGoi=${lanGoi}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      showToast(lanGoi && Number(lanGoi) > 1 ? `Đã hoàn tất đợt gọi thêm (Đợt ${lanGoi}) của đơn!` : 'Đã hoàn tất toàn bộ đồ uống trong đơn!', 'success');
      await loadKdsTickets();
      if (currentKdsViewMode === 'batch') renderKdsBatchMode();
    } else {
      showToast(data.message || 'Không thể hoàn tất đơn!', 'error');
    }
  } catch (err) {
    showToast('Lỗi khi cập nhật trạng thái đơn!', 'error');
  }
}

// Chế độ hiển thị KDS: 'orders' (theo từng vé/đơn) hoặc 'batch' (pha gộp nhiều ly)
let currentKdsViewMode = 'orders';

function switchKdsViewMode(mode) {
  currentKdsViewMode = mode;
  const ticketsContainer = document.getElementById('kds-tickets-container');
  const batchContainer = document.getElementById('kds-batch-container');
  const btnOrders = document.getElementById('btn-kds-mode-orders');
  const btnBatch = document.getElementById('btn-kds-mode-batch');

  if (mode === 'batch') {
    ticketsContainer?.classList.add('hidden');
    batchContainer?.classList.remove('hidden');
    btnBatch?.classList.add('bg-white', 'text-slate-900', 'shadow-xs');
    btnBatch?.classList.remove('text-slate-600');
    btnOrders?.classList.remove('bg-white', 'text-slate-900', 'shadow-xs');
    btnOrders?.classList.add('text-slate-600');
    renderKdsBatchMode();
  } else {
    ticketsContainer?.classList.remove('hidden');
    batchContainer?.classList.add('hidden');
    btnOrders?.classList.add('bg-white', 'text-slate-900', 'shadow-xs');
    btnOrders?.classList.remove('text-slate-600');
    btnBatch?.classList.remove('bg-white', 'text-slate-900', 'shadow-xs');
    btnBatch?.classList.add('text-slate-600');
    renderKdsTickets();
  }
  if (window.lucide) window.lucide.createIcons();
}

function renderKdsBatchMode() {
  const container = document.getElementById('kds-batch-container');
  if (!container) return;

  const dishMap = new Map();

  AppState.kdsTickets.forEach(ticket => {
    (ticket.items || []).forEach(it => {
      const key = it.TenMon;
      if (!dishMap.has(key)) {
        dishMap.set(key, {
          tenMon: it.TenMon,
          maMon: it.MaMon,
          totalQty: 0,
          pendingItems: [],
          inProgressItems: [],
          completedItems: [],
          tables: new Map()
        });
      }

      const entry = dishMap.get(key);
      entry.totalQty += it.SoLuong;

      const tblName = ticket.TenBan || 'Mang Đi';
      entry.tables.set(tblName, (entry.tables.get(tblName) || 0) + it.SoLuong);

      if (it.TrangThaiPhaChe === 'ChoLam') {
        entry.pendingItems.push(it);
      } else if (it.TrangThaiPhaChe === 'DangLam') {
        entry.inProgressItems.push(it);
      } else {
        entry.completedItems.push(it);
      }
    });
  });

  const dishes = Array.from(dishMap.values()).filter(d => (d.pendingItems.length > 0 || d.inProgressItems.length > 0));

  if (dishes.length === 0) {
    container.innerHTML = `
      <div class="col-span-full w-full text-center py-24 text-slate-400 text-sm">
        <div class="text-4xl mb-3 opacity-30">☕</div>
        Hiện không có món nào đang chờ pha chế gộp.<br>Tất cả ly nước đã hoàn tất!
      </div>
    `;
    return;
  }

  let html = '';
  dishes.forEach(d => {
    const uncompletedIds = [...d.pendingItems, ...d.inProgressItems].map(i => i.MaChiTiet);
    const pendingIds = d.pendingItems.map(i => i.MaChiTiet);
    const pendingCups = d.pendingItems.reduce((sum, i) => sum + i.SoLuong, 0);
    const inProgressCups = d.inProgressItems.reduce((sum, i) => sum + i.SoLuong, 0);
    const activeCups = pendingCups + inProgressCups;

    const tableChips = Array.from(d.tables.entries()).map(([tbl, qty]) => `
      <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-medium text-[11px] border border-slate-200">
        ${tbl} (x${qty})
      </span>
    `).join(' ');

    html += `
      <div class="bg-white border border-slate-200 hover:border-amber-400 rounded-2xl p-4 shadow-xs hover:shadow-md transition flex flex-col justify-between">
        <div>
          <div class="flex items-start justify-between gap-2 border-b border-slate-100 pb-3 mb-3">
            <div>
              <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-800 uppercase font-mono">Pha Gộp Ly</span>
              <h3 class="font-extrabold text-sm text-slate-900 mt-1">${d.tenMon}</h3>
            </div>
            <div class="text-right">
              <span class="text-2xl font-black text-amber-600 font-mono">${activeCups}</span>
              <span class="text-[10px] text-slate-400 block font-bold">LY CẦN PHA</span>
            </div>
          </div>

          <div class="space-y-2 mb-4">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>⏳ Đang chờ làm:</span>
              <span class="font-mono font-bold text-amber-700">${pendingCups} ly</span>
            </div>
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>🔄 Đang pha chế:</span>
              <span class="font-mono font-bold text-sky-700">${inProgressCups} ly</span>
            </div>
            <div>
              <span class="text-[11px] text-slate-500 font-medium block mb-1">Các bàn đang chờ:</span>
              <div class="flex flex-wrap gap-1">
                ${tableChips}
              </div>
            </div>
          </div>
        </div>

        <div class="pt-3 border-t border-slate-100 space-y-2">
          ${pendingCups > 0 ? `
            <button class="w-full py-2 px-3 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold transition shadow-xs flex items-center justify-center gap-1.5 cursor-pointer kds-batch-action" data-status="DangLam" data-ids="${pendingIds.join(',')}">
              <i data-lucide="play" class="w-3.5 h-3.5"></i> Bắt đầu pha tất cả (${pendingCups} ly)
            </button>
          ` : ''}
          <button class="w-full py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-xs flex items-center justify-center gap-1.5 cursor-pointer kds-batch-action" data-status="HoanThanh" data-ids="${uncompletedIds.join(',')}">
            <i data-lucide="check-check" class="w-3.5 h-3.5"></i> Hoàn thành tất cả (${activeCups} ly)
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.kds-batch-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = btn.getAttribute('data-status');
      const idsStr = btn.getAttribute('data-ids');
      if (!idsStr || !status) return;
      const ids = idsStr.split(',').map(s => s.trim()).filter(Boolean);
      btn.disabled = true;
      btn.textContent = '⏳ Đang xử lý...';
      await updateKdsBatchStatus(ids, status);
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

async function updateKdsBatchStatus(itemIds, nextStatus) {
  try {
    const res = await fetch('/api/orders/kds/items/batch-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds, trangThai: nextStatus })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Đã cập nhật ${itemIds.length} ly nước thành công!`, 'success');
      await loadKdsTickets();
      if (currentKdsViewMode === 'batch') {
        renderKdsBatchMode();
      }
    } else {
      showToast(data.message || 'Cập nhật thất bại!', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối khi cập nhật hàng loạt!', 'error');
  }
}

async function updateKdsItemStatus(itemId, status) {
  try {
    const res = await fetch(`/api/orders/kds/items/${itemId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await res.json();
    if (data.success) {
      scheduleKdsTicketsReload(60);
    }
  } catch (err) {
    console.error('Lỗi cập nhật KDS item status', err);
    scheduleKdsTicketsReload(0);
  }
}

// =====================================================================================
// ESC/POS PRINTER & DRAWER SIMULATOR
// =====================================================================================
async function fetchAndPreviewReceipt(soHoaDon) {
  try {
    const res = await fetch(`/api/orders/${soHoaDon}/receipt`);
    const data = await res.json();
    if (data.success) {
      const text = data.data.textContent;
      const preview = document.getElementById('receipt-text-preview');
      if (preview) {
        preview.textContent = text;
        const paper = preview.closest('.receipt-paper');
        if (paper) {
          paper.classList.remove('animate-paper-feed');
          void paper.offsetWidth; // trigger reflow
          paper.classList.add('animate-paper-feed');
        }
      }
      const printEl = document.getElementById('print-receipt-content');
      if (printEl) {
        printEl.textContent = text;
      }
    }
  } catch (e) {
    console.warn('Lỗi xem trước bill', e);
  }
}

// Helper an toàn tránh XSS khi xuất hóa đơn
function escapeReceiptHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Chuyển đổi định dạng text thô sang mẫu hóa đơn in nhiệt HTML cấu trúc chuẩn
// Giúp căn chỉnh cột tuyệt đối chuẩn xác (Tên món, SL, Đơn giá, Thành tiền), không bao giờ vỡ dòng
function formatReceiptHtml(rawText) {
  if (!rawText || !rawText.trim()) return '';
  const lines = rawText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const header = [];
  const meta = [];
  const items = [];
  const totals = [];
  const footer = [];

  let section = 'header';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('=====')) {
      if (section === 'header') section = 'meta';
      else if (section === 'totals') section = 'footer';
      continue;
    }
    if (line.includes('-----')) {
      if (section === 'meta') {
        section = 'items-header';
        continue;
      }
      if (section === 'items-header') {
        section = 'items';
        continue;
      }
      if (section === 'items') {
        section = 'totals';
        continue;
      }
    }

    if (section === 'header') {
      header.push(line);
    } else if (section === 'meta') {
      meta.push(line);
    } else if (section === 'items') {
      if (line.startsWith('*')) {
        if (items.length > 0) items[items.length - 1].note = line;
      } else {
        const parts = line.split(/\s{2,}/);
        if (parts.length >= 4) {
          items.push({ name: parts[0], qty: parts[1], price: parts[2], total: parts[3] });
        } else {
          const m = line.match(/^(.*?)\s+(\d+)\s+([0-9.,]+)\s+([0-9.,]+)$/);
          if (m) {
            items.push({ name: m[1], qty: m[2], price: m[3], total: m[4] });
          } else {
            items.push({ name: line, qty: '', price: '', total: '' });
          }
        }
      }
    } else if (section === 'totals') {
      totals.push(line);
    } else if (section === 'footer') {
      footer.push(line);
    }
  }

  // Nếu không nhận diện được danh sách món, fallback về khối <pre> an toàn
  if (items.length === 0) {
    return `<div class="receipt-print-card"><pre class="receipt-pre font-mono">${escapeReceiptHtml(rawText)}</pre></div>`;
  }

  // Tiêu đề quán
  const headerHtml = header.map((h, idx) => {
    if (idx === 0) return `<div style="font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">${escapeReceiptHtml(h)}</div>`;
    return `<div style="font-size: 10px; line-height: 1.3;">${escapeReceiptHtml(h)}</div>`;
  }).join('');

  // Thông tin hóa đơn / Bàn / Ngày giờ
  const metaHtml = meta.map(m => {
    if (m.includes('|')) {
      const parts = m.split('|');
      return `<div style="display: flex; justify-content: space-between; font-size: 10px;"><span>${escapeReceiptHtml(parts[0].trim())}</span><span>${escapeReceiptHtml(parts[1].trim())}</span></div>`;
    }
    const isId = m.toUpperCase().includes('HÓA ĐƠN') || m.toUpperCase().includes('PHIẾU');
    const style = isId ? 'font-weight: bold; font-size: 10.5px;' : 'font-size: 10px;';
    return `<div style="${style}">${escapeReceiptHtml(m)}</div>`;
  }).join('');

  // Bảng chi tiết món: Đảm bảo 100% không bao giờ vỡ cột, không ngắt đôi chữ
  const itemsHtml = items.map(it => `
    <tr style="border-bottom: 1px dashed #cbd5e1; vertical-align: top;">
      <td style="padding: 3px 2px; text-align: left; font-weight: 600; font-size: 10.5px; line-height: 1.25;">
        ${escapeReceiptHtml(it.name)}
        ${it.note ? `<div style="font-size: 9px; font-style: italic; font-weight: 400; color: #334155; margin-top: 1px;">${escapeReceiptHtml(it.note)}</div>` : ''}
      </td>
      <td style="padding: 3px 2px; text-align: center; font-weight: bold; font-size: 10.5px; font-family: monospace;">${escapeReceiptHtml(it.qty)}</td>
      <td style="padding: 3px 2px; text-align: right; font-size: 10.5px; font-family: monospace;">${escapeReceiptHtml(it.price)}</td>
      <td style="padding: 3px 2px; text-align: right; font-weight: bold; font-size: 10.5px; font-family: monospace;">${escapeReceiptHtml(it.total)}</td>
    </tr>
  `).join('');

  // Tổng cộng / Thanh toán
  const totalsHtml = totals.map(t => {
    const colonIdx = t.indexOf(':');
    if (colonIdx > -1) {
      const label = t.substring(0, colonIdx + 1).trim();
      const val = t.substring(colonIdx + 1).trim();
      const isGrand = label.toUpperCase().includes('THANH TOÁN') || label.toUpperCase().includes('TỔNG CỘNG') || label.toUpperCase().includes('CẦN THANH TOÁN');
      if (isGrand) {
        return `<div style="display: flex; justify-content: space-between; font-weight: 800; font-size: 13px; border-top: 1px dashed #000; padding-top: 4px; margin-top: 2px;"><span>${escapeReceiptHtml(label)}</span><span style="font-family: monospace;">${escapeReceiptHtml(val)}</span></div>`;
      }
      return `<div style="display: flex; justify-content: space-between; font-size: 10.5px; line-height: 1.35;"><span>${escapeReceiptHtml(label)}</span><span style="font-family: monospace; font-weight: 600;">${escapeReceiptHtml(val)}</span></div>`;
    }
    return `<div style="font-size: 10.5px;">${escapeReceiptHtml(t)}</div>`;
  }).join('');

  // Lời cảm ơn & Wifi
  const footerHtml = footer.map((f, idx) => {
    if (idx === 0) return `<div style="font-weight: 700; font-size: 10.5px; text-transform: uppercase;">${escapeReceiptHtml(f)}</div>`;
    return `<div style="font-size: 9.5px;">${escapeReceiptHtml(f)}</div>`;
  }).join('');

  return `
    <div class="receipt-print-card" style="width: 100%; box-sizing: border-box; color: #000000; background: #ffffff;">
      <div style="text-align: center; padding-bottom: 4px;">${headerHtml}</div>
      <div style="border-top: 1px dashed #000000; margin: 4px 0;"></div>
      <div style="padding: 2px 0;">${metaHtml}</div>
      <div style="border-top: 1px dashed #000000; margin: 4px 0;"></div>
      <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
        <thead>
          <tr style="border-bottom: 1px dashed #000000; font-weight: bold; font-size: 10px;">
            <th style="padding: 2px; text-align: left; width: 44%;">TÊN MÓN</th>
            <th style="padding: 2px; text-align: center; width: 12%;">SL</th>
            <th style="padding: 2px; text-align: right; width: 22%;">ĐƠN GIÁ</th>
            <th style="padding: 2px; text-align: right; width: 22%;">THÀNH TIỀN</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>
      <div style="border-top: 1px dashed #000000; margin: 4px 0;"></div>
      <div style="padding: 2px 0;">${totalsHtml}</div>
      <div style="border-top: 1px dashed #000000; margin: 4px 0;"></div>
      <div style="text-align: center; padding-top: 4px;">${footerHtml}</div>
    </div>
  `;
}

// In hóa đơn nhiệt K80 chuyên nghiệp (CHỈ in riêng hóa đơn, ẩn hoàn toàn giao diện web)
function printReceipt(text = null) {
  const content = text || document.getElementById('receipt-text-preview')?.textContent || '';
  if (!content.trim()) {
    showToast('Chưa có nội dung hóa đơn để in!', 'warning');
    return;
  }
  const printArea = document.getElementById('thermal-receipt-print-area');
  if (printArea) {
    printArea.innerHTML = formatReceiptHtml(content);
  }

  // Gọi in trình duyệt - @media print sẽ ẩn toàn bộ trang web và chỉ in #thermal-receipt-print-area
  window.print();
}

window.printReceipt = printReceipt;

// Lắng nghe sự kiện trước khi in để luôn đảm bảo nội dung hóa đơn được nạp đầy đủ
window.addEventListener('beforeprint', () => {
  const printArea = document.getElementById('thermal-receipt-print-area');
  const previewEl = document.getElementById('receipt-text-preview');
  if (printArea && previewEl && previewEl.textContent.trim()) {
    printArea.innerHTML = formatReceiptHtml(previewEl.textContent);
  }
});

function triggerDrawerKickPulse() {
  // Phát âm thanh chuông mở két
  if (typeof window.playNotificationChime === 'function') {
    window.playNotificationChime();
  }

  // Khay két trong Tab Máy In (ESC/POS hardware)
  const drawer = document.getElementById('drawer-graphic');
  const msg = document.getElementById('drawer-status-msg');
  if (drawer && msg) {
    drawer.classList.remove('drawer-opened');
    void drawer.offsetWidth;
    drawer.classList.add('drawer-opened');
    msg.textContent = '⚡ XUNG ĐIỆN 1B 70 00 19 FA: NGĂN KÉO TIỀN ĐÃ BUNG MỞ TỰ ĐỘNG!';
    msg.className = 'text-xs text-emerald-700 font-bold mt-2';

    setTimeout(() => {
      drawer.classList.remove('drawer-opened');
      msg.textContent = 'Ngăn kéo đã đóng lại.';
      msg.className = 'text-xs text-slate-500 mt-2';
    }, 3500);
  }

  // Khay két trong Tab Chốt Ca & Két Tiền
  const liveBadge = document.getElementById('drawer-live-badge');
  const liveMsg = document.getElementById('drawer-live-msg');
  if (liveBadge && liveMsg) {
    liveBadge.textContent = '⚡ ĐANG BUNG MỞ';
    liveBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 font-mono animate-pulse border border-emerald-300';
    liveMsg.textContent = '⚡ Lệnh ESC/POS 1B 70: Khóa cơ điện đã bung chốt! Ngăn kéo tiền mặt đang mở.';
    liveMsg.className = 'text-xs text-emerald-700 font-bold mt-0.5';

    setTimeout(() => {
      liveBadge.textContent = 'Đang Đóng';
      liveBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 font-mono';
      liveMsg.textContent = 'Sẵn sàng nhận lệnh in bill thanh toán hoặc bấm nút kích xung mở két bên cạnh';
      liveMsg.className = 'text-xs text-slate-500 mt-0.5';
    }, 3500);
  }

  showToast('⚡ Xung điện ESC/POS: Ngăn kéo tiền mặt đã bung mở!', 'info');
}

// =====================================================================================
// SHIFT MANAGEMENT & CASH DRAWER BALANCING (CHỐT CA & BÀN GIAO KÉT TIỀN)
// =====================================================================================
function updateShiftUI(shift) {
  const headerShift = document.getElementById('header-shift-name');
  if (headerShift) headerShift.textContent = shift.TenCa || 'Ca Sáng';

  const titleEl = document.getElementById('shift-title');
  if (titleEl) titleEl.textContent = `${shift.TenCa} (${shift.GioBatDau} - ${shift.GioKetThuc})`;

  const cashierEl = document.getElementById('shift-cashier-name');
  if (cashierEl) cashierEl.textContent = shift.TenNhanVien || 'Lê Thị Mai';

  const codeEl = document.getElementById('shift-code');
  if (codeEl) codeEl.textContent = shift.MaGiaoCa;

  const openTimeEl = document.getElementById('shift-open-time');
  if (openTimeEl) openTimeEl.textContent = `Bắt đầu: ${shift.ThoiGianMoCa ? shift.ThoiGianMoCa.slice(11, 16) : '06:30'}`;

  document.getElementById('shift-cash-initial').textContent = `${Number(shift.TienDauCa || 0).toLocaleString('vi-VN')} đ`;
  document.getElementById('shift-revenue-cash').textContent = `${Number(shift.DoanhThuTienMat || 0).toLocaleString('vi-VN')} đ`;
  document.getElementById('shift-revenue-bank').textContent = `${Number(shift.DoanhThuChuyenKhoan || 0).toLocaleString('vi-VN')} đ`;
  document.getElementById('shift-cash-theoretical').textContent = `${Number(shift.TienMatLyThuyetTrongKet || 0).toLocaleString('vi-VN')} đ`;

  const inputActual = document.getElementById('input-actual-cash');
  if (inputActual) {
    if (!inputActual.value || Number(inputActual.value) === 0) {
      inputActual.value = shift.TienMatLyThuyetTrongKet;
    }
    calculateShiftDifference();
  }
}

function calculateShiftDifference() {
  const diffEl = document.getElementById('shift-diff-amount');
  if (!diffEl) return;

  if (!AppState.currentShift) {
    diffEl.textContent = 'Chưa có ca làm việc nào đang mở';
    diffEl.className = 'text-sm font-mono font-bold text-slate-400';
    return;
  }

  const actual = Number(document.getElementById('input-actual-cash')?.value || 0);
  const theoretical = Number(AppState.currentShift.TienMatLyThuyetTrongKet || 0);
  const diff = actual - theoretical;

  if (diff === 0) {
    diffEl.textContent = '0 đ (Két tiền khớp chuẩn 100%)';
    diffEl.className = 'text-sm font-mono font-bold text-emerald-600';
  } else if (diff > 0) {
    diffEl.textContent = `+${diff.toLocaleString('vi-VN')} đ (Két dư thừa tiền mặt)`;
    diffEl.className = 'text-sm font-mono font-bold text-amber-600';
  } else {
    diffEl.textContent = `${diff.toLocaleString('vi-VN')} đ (Két thâm hụt tiền mặt)`;
    diffEl.className = 'text-sm font-mono font-bold text-rose-600';
  }
}

function matchTheoreticalCash() {
  if (!AppState.currentShift) return;
  const input = document.getElementById('input-actual-cash');
  if (input) {
    input.value = AppState.currentShift.TienMatLyThuyetTrongKet;
    calculateShiftDifference();
  }
}

function addCashOffset(offset) {
  if (!AppState.currentShift) return;
  const input = document.getElementById('input-actual-cash');
  if (input) {
    input.value = Number(AppState.currentShift.TienMatLyThuyetTrongKet || 0) + offset;
    calculateShiftDifference();
  }
}

async function closeCurrentShift() {
  if (!AppState.currentShift) {
    showToast('Hiện tại chưa có ca nào đang mở để chốt! Bạn có thể bấm "Mở Ca Mới".', 'warning');
    return;
  }

  const actualInput = document.getElementById('input-actual-cash');
  if (!actualInput || actualInput.value === '') {
    showToast('Vui lòng kiểm đếm và nhập số tiền mặt thực tế trong két!', 'warning');
    actualInput?.focus();
    return;
  }

  const actual = Number(actualInput.value);
  const notes = document.getElementById('input-shift-notes')?.value || '';

  const btn = document.getElementById('btn-close-shift');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/shift/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maGiaoCa: AppState.currentShift.MaGiaoCa,
        tienMatThucTe: actual,
        ghiChu: notes
      })
    });
    const result = await res.json();
    if (result.success) {
      triggerDrawerKickPulse(); // Kích mở két tiền để kiểm kê hoàn tất
      showToast(result.message || 'Đã chốt ca & đóng két thành công!', 'success');
      await loadShiftData();
      await loadProfitAndLoss();
    } else {
      showToast(`Lỗi: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi chốt ca: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleOpenShiftSubmit(e) {
  e.preventDefault();
  const maCa = document.getElementById('open-shift-ca')?.value;
  const maNhanVien = document.getElementById('open-shift-cashier')?.value;
  const tienDauCa = Number(document.getElementById('open-shift-initial-cash')?.value || 0);
  const ghiChu = document.getElementById('open-shift-notes')?.value.trim();

  if (!maCa || !maNhanVien) {
    showToast('Vui lòng chọn ca làm việc và thu ngân nhận ca!', 'warning');
    return;
  }

  const btn = document.getElementById('btn-submit-open-shift');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/shift/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maCa, maNhanVien, tienDauCa, ghiChu })
    });
    const result = await res.json();
    if (result.success) {
      triggerDrawerKickPulse(); // Bung két tiền để bỏ tiền thối đầu ca vào
      showToast(result.message || 'Đã mở ca làm việc và nạp két tiền thành công!', 'success');
      await loadShiftData();
    } else {
      showToast(`Lỗi mở ca: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi mở ca: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function approveShiftRecord(maGiaoCa) {
  if (AppState.currentRole !== 'QuanLy' && AppState.currentRole !== 'ChuQuan') {
    showToast('Chỉ Quản Lý (Admin) mới có quyền phê duyệt bàn giao ca!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/shift/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-role': AppState.currentRole
      },
      body: JSON.stringify({ maGiaoCa, maNguoiXacNhan: 'NV02' })
    });
    const result = await res.json();
    if (result.success) {
      showToast('Đã phê duyệt bàn giao ca thành công!', 'success');
      await loadShiftData();
    } else {
      showToast(`Lỗi: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi phê duyệt: ${err.message}`, 'error');
  }
}

function renderShiftHistoryTable(history) {
  const tbody = document.getElementById('shift-history-tbody');
  if (!tbody) return;

  if (!history || history.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-8 text-slate-400">Chưa có lịch sử giao ca nào.</td></tr>`;
    return;
  }

  tbody.innerHTML = history.map(item => {
    let statusBadge = '';
    let actionBtn = '';

    if (item.TrangThai === 'DangMo') {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">Đang Mở</span>';
      actionBtn = `<button onclick="window.switchMainTab('shift')" class="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 rounded-lg text-[11px] font-bold border border-amber-300 transition cursor-pointer">Chốt Ca</button>`;
    } else if (item.TrangThai === 'DaChot') {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">Chờ Quản Lý Duyệt</span>';
      actionBtn = `<button onclick="window.approveShiftRecord('${item.MaGiaoCa}')" class="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[11px] font-bold transition shadow-2xs cursor-pointer">Duyệt Ca</button>`;
    } else {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">Đã Phê Duyệt</span>';
      actionBtn = '<span class="text-emerald-600 font-bold text-xs">✔ Đã duyệt</span>';
    }

    const diff = Number(item.ChenhLechThuaThieu || 0);
    let diffBadge = '<span class="font-mono text-emerald-600 font-bold text-xs">0 đ</span>';
    if (diff > 0) {
      diffBadge = `<span class="font-mono text-amber-600 font-bold text-xs">+${diff.toLocaleString('vi-VN')} đ</span>`;
    } else if (diff < 0) {
      diffBadge = `<span class="font-mono text-rose-600 font-bold text-xs">${diff.toLocaleString('vi-VN')} đ</span>`;
    }

    const openTime = item.ThoiGianMoCa ? item.ThoiGianMoCa.slice(11, 16) : '---';
    const closeTime = item.ThoiGianDongCa ? item.ThoiGianDongCa.slice(11, 16) : '---';

    return `
      <tr class="hover:bg-slate-50/80 transition">
        <td class="py-3 px-4 font-mono font-bold text-amber-800 text-xs">${item.MaGiaoCa}</td>
        <td class="py-3 px-4 font-bold text-slate-900 text-xs">${item.TenCa || item.MaCa}</td>
        <td class="py-3 px-4 text-slate-700 text-xs">${item.TenNhanVien || item.MaNhanVien}</td>
        <td class="py-3 px-4 text-xs font-mono text-slate-600">${item.NgayLamViec || ''} (${openTime} ➔ ${closeTime})</td>
        <td class="py-3 px-4 text-right font-mono font-semibold text-xs">${Number(item.TienDauCa || 0).toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-right font-mono font-bold text-emerald-700 text-xs">${Number(item.DoanhThuTienMat || 0).toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-right font-mono font-black text-slate-900 text-xs">${Number(item.TienMatThucTeTrongKet || 0).toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-center">${diffBadge}</td>
        <td class="py-3 px-4 text-center">${statusBadge}</td>
        <td class="py-3 px-4 text-center">${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

window.triggerDrawerKickPulse = triggerDrawerKickPulse;
window.matchTheoreticalCash = matchTheoreticalCash;
window.addCashOffset = addCashOffset;
window.approveShiftRecord = approveShiftRecord;

// =====================================================================================
// P&L PROFIT & LOSS REPORT (BÁO CÁO LÃI - LỖ CHUẨN 23 BẢNG VỚI BỘ LỌC NGÀY)
// =====================================================================================
// pnlCurrentRange defined at top
// pnlStartDate defined at top
// pnlEndDate defined at top

async function loadProfitAndLoss(startDate, endDate) {
  try {
    if (startDate !== undefined) pnlStartDate = startDate;
    if (endDate !== undefined) pnlEndDate = endDate;

    let url = `/api/reports/pnl?role=${AppState.currentRole}`;
    if (pnlStartDate) url += `&startDate=${pnlStartDate}`;
    if (pnlEndDate) url += `&endDate=${pnlEndDate}`;

    const res = await fetch(url, {
      headers: { 'x-user-role': AppState.currentRole }
    });
    const data = await res.json();
    if (data.success && data.data) {
      const pnl = data.data;

      // Cập nhật nhãn hiển thị ngày
      const dateLabel = document.getElementById('pnl-current-date-label');
      if (dateLabel) {
        if (!pnlStartDate && !pnlEndDate) {
          dateLabel.textContent = '📅 Toàn Bộ Thời Gian';
        } else if (pnlStartDate === pnlEndDate) {
          const parts = pnlStartDate.split('-');
          dateLabel.textContent = `📅 Ngày: ${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          const p1 = pnlStartDate.split('-');
          const p2 = pnlEndDate.split('-');
          dateLabel.textContent = `📅 Từ ${p1[2]}/${p1[1]}/${p1[0]} đến ${p2[2]}/${p2[1]}/${p2[0]}`;
        }
      }

      // Cập nhật giá trị ô chọn ngày nếu đang xem ngày đơn lẻ
      const customDateInput = document.getElementById('pnl-custom-date');
      if (customDateInput && pnlStartDate) {
        customDateInput.value = pnlStartDate;
      }

      // Cập nhật 4 thẻ KPI tổng quan
      document.getElementById('pnl-revenue').textContent = `${(pnl.doanhThuBanHang || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('pnl-orders-count').textContent = `${pnl.tongDonHang || 0} đơn hoàn tất`;
      document.getElementById('pnl-cogs').textContent = `${(pnl.giaVonHangBan_COGS || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('pnl-gross-profit').textContent = `${(pnl.loiNhuanGop || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('pnl-gross-margin').textContent = `Tỉ suất: ${pnl.tiSuatLoiNhuanGop || 0}%`;

      const netEl = document.getElementById('pnl-net-profit');
      const netVal = pnl.loiNhuanRong_NetProfit || 0;
      netEl.textContent = `${netVal.toLocaleString('vi-VN')} đ`;
      if (netVal >= 0) {
        netEl.className = 'text-2xl font-mono font-black text-emerald-600 mt-1';
      } else {
        netEl.className = 'text-2xl font-mono font-black text-rose-600 mt-1';
      }
      document.getElementById('pnl-net-margin').textContent = `Tỉ suất: ${pnl.tiSuatLoiNhuanRong || 0}%`;

      // Cập nhật Bảng Phân Tích Báo Cáo Tài Chính Chuẩn (23 Bảng)
      document.getElementById('table-pnl-rev').textContent = `${(pnl.doanhThuBanHang || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-cogs').textContent = `-${(pnl.giaVonHangBan_COGS || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-gross').textContent = `${(pnl.loiNhuanGop || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-other-inc').textContent = `+${(pnl.thuKhac || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-opex').textContent = `-${(pnl.chiPhiVanHanh || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-payroll').textContent = `-${(pnl.chiPhiLuong || 0).toLocaleString('vi-VN')} đ`;
      document.getElementById('table-pnl-spoilage').textContent = `-${(pnl.chiPhiHaoHut || 0).toLocaleString('vi-VN')} đ`;

      const tblNet = document.getElementById('table-pnl-net');
      tblNet.textContent = `${netVal.toLocaleString('vi-VN')} đ`;
      if (netVal >= 0) {
        tblNet.className = 'py-3 px-3 text-right text-emerald-800 text-base font-black';
      } else {
        tblNet.className = 'py-3 px-3 text-right text-rose-700 text-base font-black';
      }
    }
  } catch (err) {
    console.error('Lỗi nạp P&L', err);
  }
}

function setPnlRange(range) {
  pnlCurrentRange = range;
  document.querySelectorAll('.btn-pnl-range').forEach(b => {
    const r = b.getAttribute('data-range');
    if (r === range) {
      b.className = 'btn-pnl-range px-3 py-1.5 rounded-xl text-xs font-bold transition bg-amber-600 text-white shadow-xs cursor-pointer';
    } else {
      b.className = 'btn-pnl-range px-3 py-1.5 rounded-xl text-xs font-bold transition bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer';
    }
  });

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (range === 'today') {
    loadProfitAndLoss(todayStr, todayStr);
  } else if (range === 'yesterday') {
    const y = new Date(now.getTime() - 86400000);
    const yStr = y.toISOString().slice(0, 10);
    loadProfitAndLoss(yStr, yStr);
  } else if (range === '7days') {
    const d7 = new Date(now.getTime() - 6 * 86400000);
    loadProfitAndLoss(d7.toISOString().slice(0, 10), todayStr);
  } else if (range === 'this_month') {
    const firstDay = `${todayStr.slice(0, 7)}-01`;
    loadProfitAndLoss(firstDay, todayStr);
  } else if (range === 'all') {
    loadProfitAndLoss('', '');
  }
}
window.setPnlRange = setPnlRange;

function setPnlCustomDate(val) {
  if (val) {
    document.querySelectorAll('.btn-pnl-range').forEach(b => {
      b.className = 'btn-pnl-range px-3 py-1.5 rounded-xl text-xs font-bold transition bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer';
    });
    loadProfitAndLoss(val, val);
  }
}
window.setPnlCustomDate = setPnlCustomDate;

// =====================================================================================
// INVENTORY & MATERIALS MANAGEMENT (QUẢN LÝ KHO & NGUYÊN VẬT LIỆU CAO CẤP)
// =====================================================================================
// inventoryMaterialsData defined at top
// inventorySuppliersData defined at top
// inventoryCurrentFilter defined at top
// inventorySearchQuery defined at top

function getMaterialMeta(m) {
  const code = (m.MaVatTu || '').toUpperCase();
  const name = (m.TenVatTu || '').toLowerCase();

  if (code.includes('ROBUSTA') || code.includes('ARABICA') || name.includes('cà phê') || name.includes('cafe')) {
    return { icon: '☕', category: 'Cà Phê Hạt', badgeBg: 'bg-amber-100 text-amber-900 border-amber-200' };
  }
  if (code.includes('SUA') || name.includes('sữa')) {
    return { icon: '🥛', category: 'Sữa & Bơ', badgeBg: 'bg-blue-100 text-blue-900 border-blue-200' };
  }
  if (code.includes('MATCHA') || name.includes('matcha')) {
    return { icon: '🍵', category: 'Trà & Bột', badgeBg: 'bg-emerald-100 text-emerald-900 border-emerald-200' };
  }
  if (code.includes('TRADAO') || code.includes('DAO') || name.includes('đào') || code.includes('CAM') || name.includes('cam') || code.includes('SYRUP')) {
    return { icon: '🍑', category: 'Siro & Trái Cây', badgeBg: 'bg-rose-100 text-rose-900 border-rose-200' };
  }
  if (code.includes('KEMCHEESE') || name.includes('cheese') || name.includes('phô mai')) {
    return { icon: '🧀', category: 'Kem & Topping', badgeBg: 'bg-yellow-100 text-yellow-900 border-yellow-200' };
  }
  if (code.includes('CROISSANT') || name.includes('bánh')) {
    return { icon: '🥐', category: 'Bánh Ngọt', badgeBg: 'bg-amber-100 text-amber-950 border-amber-200' };
  }
  if (code.includes('DUONG') || name.includes('đường')) {
    return { icon: '🍬', category: 'Nguyên Liệu Phụ', badgeBg: 'bg-orange-100 text-orange-900 border-orange-200' };
  }
  return { icon: '📦', category: 'Vật Tư', badgeBg: 'bg-slate-100 text-slate-800 border-slate-200' };
}

async function loadInventoryView() {
  try {
    const [matRes, recRes, supRes] = await Promise.all([
      fetch('/api/inventory/materials'),
      fetch('/api/inventory/recipes'),
      fetch('/api/inventory/suppliers').catch(() => ({ json: () => ({ success: true, data: [] }) }))
    ]);
    const matData = await matRes.json();
    const recData = await recRes.json();
    const supData = await supRes.json().catch(() => ({ success: true, data: [] }));

    if (matData.success) {
      inventoryMaterialsData = matData.data || [];
      if (supData.success) inventorySuppliersData = supData.data || [];

      // Tính toán 4 thẻ chỉ số KPI
      updateInventoryKpiSummary(inventoryMaterialsData);
      // Áp dụng bộ lọc và render bảng dữ liệu
      applyInventoryFilterAndRender();
    }

    if (recData.success) {
      renderRecipesTable(recData.data);
    }
  } catch (e) {
    console.error('Lỗi nạp kho:', e);
  }
}

function updateInventoryKpiSummary(materials) {
  const totalItems = materials.length;
  let lowCount = 0;
  let warningCount = 0;
  let safeCount = 0;
  let totalStockValuation = 0;

  materials.forEach(m => {
    const qty = Number(m.SoLuongTonHienTai || 0);
    const threshold = Number(m.MucToiThieuCanCanhBao || 0);
    const price = Number(m.DonGiaBinhQuan || 0);

    totalStockValuation += (qty * price);

    if (qty <= threshold) {
      lowCount++;
    } else if (qty <= threshold * 1.5) {
      warningCount++;
    } else {
      safeCount++;
    }
  });

  const safeRate = totalItems > 0 ? Math.round(((totalItems - lowCount) / totalItems) * 100) : 100;

  // Cập nhật DOM các thẻ KPI
  const elTotal = document.getElementById('inv-kpi-total-items');
  const elLow = document.getElementById('inv-kpi-low-items');
  const elLowIcon = document.getElementById('inv-kpi-low-iconbox');
  const elLowSub = document.getElementById('inv-kpi-low-sub');
  const elVal = document.getElementById('inv-kpi-total-value');
  const elSafe = document.getElementById('inv-kpi-safe-rate');

  if (elTotal) elTotal.textContent = totalItems.toString();
  if (elLow) elLow.textContent = lowCount.toString();
  if (elVal) elVal.textContent = totalStockValuation.toLocaleString('vi-VN') + ' đ';
  if (elSafe) elSafe.textContent = safeRate + '%';

  if (elLowIcon && elLowSub) {
    if (lowCount > 0) {
      elLowIcon.className = 'w-11 h-11 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 border border-rose-300 animate-pulse';
      elLowSub.className = 'text-[10px] text-rose-600 font-bold';
      elLowSub.textContent = `⚠️ Có ${lowCount} món cần nhập gấp!`;
    } else {
      elLowIcon.className = 'w-11 h-11 rounded-2xl bg-slate-100 text-slate-600 flex items-center justify-center shrink-0 border border-slate-200 transition';
      elLowSub.className = 'text-[10px] text-slate-500 font-medium';
      elLowSub.textContent = 'Dưới ngưỡng tối thiểu';
    }
  }

  // Cập nhật số đếm trên các nút lọc (filter pills)
  const countAll = document.getElementById('filter-count-all');
  const countLow = document.getElementById('filter-count-low');
  const countWarning = document.getElementById('filter-count-warning');
  const countSafe = document.getElementById('filter-count-safe');

  if (countAll) countAll.textContent = totalItems.toString();
  if (countLow) countLow.textContent = lowCount.toString();
  if (countWarning) countWarning.textContent = warningCount.toString();
  if (countSafe) countSafe.textContent = safeCount.toString();
}

function applyInventoryFilterAndRender() {
  const query = inventorySearchQuery.trim().toLowerCase();
  
  const filtered = inventoryMaterialsData.filter(m => {
    // 1. Lọc theo từ khóa tìm kiếm (Mã VT hoặc Tên vật tư)
    const matchQuery = !query || 
      (m.TenVatTu && m.TenVatTu.toLowerCase().includes(query)) ||
      (m.MaVatTu && m.MaVatTu.toLowerCase().includes(query));

    if (!matchQuery) return false;

    // 2. Lọc theo trạng thái tab
    const qty = Number(m.SoLuongTonHienTai || 0);
    const threshold = Number(m.MucToiThieuCanCanhBao || 0);

    if (inventoryCurrentFilter === 'low') {
      return qty <= threshold;
    }
    if (inventoryCurrentFilter === 'warning') {
      return qty > threshold && qty <= threshold * 1.5;
    }
    if (inventoryCurrentFilter === 'safe') {
      return qty > threshold * 1.5;
    }
    return true; // 'all'
  });

  const elCount = document.getElementById('inv-displayed-count');
  if (elCount) elCount.textContent = filtered.length.toString();

  const emptyState = document.getElementById('inventory-empty-state');
  const tableBody = document.getElementById('inventory-materials-tbody');

  if (filtered.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (tableBody) tableBody.innerHTML = '';
  } else {
    if (emptyState) emptyState.classList.add('hidden');
    renderInventoryMaterials(filtered);
  }

  if (window.lucide) window.lucide.createIcons();
}

function filterInventory(filter) {
  inventoryCurrentFilter = filter || 'all';
  document.querySelectorAll('.inv-filter-btn').forEach(b => {
    const f = b.getAttribute('data-filter');
    if (f === inventoryCurrentFilter) {
      b.className = 'inv-filter-btn px-3 py-1.5 rounded-xl text-xs font-bold transition bg-slate-900 text-white shadow-xs cursor-pointer';
    } else {
      b.className = 'inv-filter-btn px-3 py-1.5 rounded-xl text-xs font-bold transition bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer';
    }
  });
  applyInventoryFilterAndRender();
}
window.filterInventory = filterInventory;


function renderInventoryMaterials(materials) {
  const tbody = document.getElementById('inventory-materials-tbody');
  if (!tbody) return;

  let html = '';
  materials.forEach(m => {
    const meta = getMaterialMeta(m);
    const currentQty = Number(m.SoLuongTonHienTai || 0);
    const threshold = Number(m.MucToiThieuCanCanhBao || 0);
    const unitPrice = Number(m.DonGiaBinhQuan || 0);
    const totalAmount = currentQty * unitPrice;
    const dvt = m.DonViTinh || '';

    // Tính toán % tiến trình dự trữ
    const maxReference = threshold > 0 ? (threshold * 2.5) : (currentQty > 0 ? currentQty : 100);
    const percent = Math.min(100, Math.max(4, Math.round((currentQty / maxReference) * 100)));

    let statusBadge = '';
    let barColor = 'bg-emerald-500';
    let progressLabel = '';
    let rowHighlight = 'hover:bg-slate-50/80';

    if (currentQty <= threshold) {
      barColor = 'bg-rose-500';
      rowHighlight = 'bg-rose-50/40 hover:bg-rose-50/80';
      progressLabel = `<span class="text-rose-600 font-extrabold">Cạn kiệt (${Math.round((currentQty / (threshold || 1)) * 100)}%)</span>`;
      statusBadge = `
        <span class="whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-extrabold inline-flex items-center gap-1.5 bg-rose-100 text-rose-800 border border-rose-300 shadow-2xs">
          <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span> Cần Nhập Gấp
        </span>
      `;
    } else if (currentQty <= threshold * 1.5) {
      barColor = 'bg-amber-500';
      rowHighlight = 'bg-amber-50/20 hover:bg-amber-50/50';
      progressLabel = `<span class="text-amber-700 font-bold">Sắp chạm ngưỡng (${Math.round((currentQty / (threshold || 1)) * 100)}%)</span>`;
      statusBadge = `
        <span class="whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 bg-amber-100 text-amber-800 border border-amber-300 shadow-2xs">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Sắp Hết
        </span>
      `;
    } else {
      barColor = 'bg-emerald-500';
      progressLabel = `<span class="text-emerald-700 font-medium">Tồn dồi dào (${Math.round((currentQty / (threshold || 1)) * 100)}%)</span>`;
      statusBadge = `
        <span class="whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Đủ Tồn
        </span>
      `;
    }

    html += `
      <tr class="transition border-b border-slate-100 ${rowHighlight}">
        <!-- Cột 1: Vật tư & Phân loại -->
        <td class="py-3 px-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center text-base border shadow-2xs shrink-0 ${meta.badgeBg}">
              <span>${meta.icon}</span>
            </div>
            <div>
              <div class="font-extrabold text-slate-900 text-xs">${m.TenVatTu}</div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded border border-slate-200">${m.MaVatTu}</span>
                <span class="text-[10px] text-slate-400">• ${meta.category}</span>
              </div>
            </div>
          </div>
        </td>

        <!-- Cột 2: Tồn kho thực tế -->
        <td class="py-3 px-4 text-right">
          <div class="font-mono font-black text-sm ${currentQty <= threshold ? 'text-rose-600' : 'text-slate-900'}">
            ${currentQty.toLocaleString('vi-VN')}
          </div>
          <span class="text-[10px] font-bold text-slate-400 uppercase">${dvt}</span>
        </td>

        <!-- Cột 3: Mức dự trữ trực quan (Progress Meter) -->
        <td class="py-3 px-4">
          <div class="space-y-1 w-full max-w-[190px]">
            <div class="flex items-center justify-between text-[10px]">
              ${progressLabel}
              <span class="font-mono text-slate-400 font-bold">${percent}%</span>
            </div>
            <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200/80">
              <div class="h-full rounded-full transition-all duration-500 ${barColor}" style="width: ${percent}%"></div>
            </div>
          </div>
        </td>

        <!-- Cột 4: Ngưỡng báo động -->
        <td class="py-3 px-4 text-right">
          <span class="font-mono font-bold text-slate-600 text-xs">${threshold.toLocaleString('vi-VN')}</span>
          <span class="text-[10px] text-slate-400 ml-0.5">${dvt}</span>
        </td>

        <!-- Cột 5: Đơn giá bình quân -->
        <td class="py-3 px-4 text-right">
          <span class="font-mono font-semibold text-slate-700 text-xs">${unitPrice.toLocaleString('vi-VN')} đ</span>
        </td>

        <!-- Cột 6: Tổng tiền tồn -->
        <td class="py-3 px-4 text-right">
          <span class="font-mono font-extrabold text-amber-900 text-xs">${totalAmount.toLocaleString('vi-VN')} đ</span>
        </td>

        <!-- Cột 7: Trạng thái -->
        <td class="py-3 px-4 text-center">
          ${statusBadge}
        </td>

        <!-- Cột 8: Thao tác nhanh -->
        <td class="py-3 px-4 text-center">
          <div class="flex items-center justify-center gap-1.5">
            <button onclick="openStockInModal('${m.MaVatTu}')" class="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 hover:text-emerald-800 border border-emerald-200 rounded-lg text-[11px] font-bold transition flex items-center gap-1 shadow-2xs active:scale-95 cursor-pointer" title="Lập phiếu nhập thêm vật tư này">
              <i data-lucide="plus" class="w-3 h-3"></i> Nhập Hàng
            </button>
            <button onclick="openSpoilageModal('${m.MaVatTu}')" class="px-2 py-1 bg-slate-50 hover:bg-rose-50 text-slate-600 hover:text-rose-700 border border-slate-200 hover:border-rose-200 rounded-lg text-[11px] font-semibold transition flex items-center gap-1 shadow-2xs active:scale-95 cursor-pointer" title="Báo hao hụt hoặc hỏng hóc">
              <i data-lucide="trash-2" class="w-3 h-3 text-slate-400"></i> Hao Hụt
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// Giữ lại để tương thích không gây lỗi nếu có code gọi
function renderRecipesTable(recipes) {
  const tbody = document.getElementById('recipes-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
}

// =====================================================================================
// MODAL NHẬP KHO (PHIEU_NHAP_KHO) & BÁO HAO HỤT (PHIEU_HUY_HAO_HUT)
// =====================================================================================
function openStockInModal(preselectedMaVatTu = null) {
  const modal = document.getElementById('modal-stockin');
  if (!modal) return;

  const selectMat = document.getElementById('stockin-material-select');
  const selectSup = document.getElementById('stockin-supplier-select');
  const inputQty = document.getElementById('stockin-qty-input');
  const inputPrice = document.getElementById('stockin-price-input');
  const inputNotes = document.getElementById('stockin-notes-input');
  const badgeUnit = document.getElementById('stockin-unit-badge');
  const preview = document.getElementById('stockin-total-preview');

  // Nạp danh sách nguyên vật liệu vào select
  if (selectMat) {
    selectMat.innerHTML = inventoryMaterialsData.map(m => 
      `<option value="${m.MaVatTu}" data-dvt="${m.DonViTinh}" data-price="${m.DonGiaBinhQuan || 0}">
        ${m.TenVatTu} (${m.MaVatTu}) - Tồn: ${Number(m.SoLuongTonHienTai).toLocaleString('vi-VN')} ${m.DonViTinh}
      </option>`
    ).join('');

    if (preselectedMaVatTu) {
      selectMat.value = preselectedMaVatTu;
    }
  }

  // Nạp danh sách nhà cung cấp
  if (selectSup && inventorySuppliersData.length > 0) {
    selectSup.innerHTML = inventorySuppliersData.map(s => 
      `<option value="${s.MaNCC}">${s.TenNCC} (${s.SoDienThoai || ''})</option>`
    ).join('');
  }

  // Cập nhật đơn vị tính và giá mặc định
  function syncSelectedMaterialInfo() {
    const opt = selectMat.options[selectMat.selectedIndex];
    if (opt) {
      const dvt = opt.getAttribute('data-dvt') || '';
      const price = opt.getAttribute('data-price') || 0;
      if (badgeUnit) badgeUnit.textContent = dvt;
      if (inputPrice) inputPrice.value = price;
      updateStockInPreview();
    }
  }

  function updateStockInPreview() {
    const qty = parseFloat(inputQty.value) || 0;
    const price = parseFloat(inputPrice.value) || 0;
    if (preview) {
      preview.textContent = (qty * price).toLocaleString('vi-VN') + ' đ';
    }
  }

  selectMat.onchange = syncSelectedMaterialInfo;
  inputQty.oninput = updateStockInPreview;
  inputPrice.oninput = updateStockInPreview;

  // Reset inputs
  if (inputQty) inputQty.value = '';
  if (inputNotes) inputNotes.value = '';
  syncSelectedMaterialInfo();

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}


function closeStockInModal() {
  document.getElementById('modal-stockin')?.classList.add('hidden');
}

function openSpoilageModal(preselectedMaVatTu = null) {
  const modal = document.getElementById('modal-spoilage');
  if (!modal) return;

  const selectMat = document.getElementById('spoilage-material-select');
  const inputQty = document.getElementById('spoilage-qty-input');
  const currentStockDisplay = document.getElementById('spoilage-current-stock');
  const badgeUnit = document.getElementById('spoilage-unit-badge');
  const preview = document.getElementById('spoilage-value-preview');

  if (selectMat) {
    selectMat.innerHTML = inventoryMaterialsData.map(m => 
      `<option value="${m.MaVatTu}" data-dvt="${m.DonViTinh}" data-qty="${m.SoLuongTonHienTai}" data-price="${m.DonGiaBinhQuan || 0}">
        ${m.TenVatTu} (${m.MaVatTu})
      </option>`
    ).join('');

    if (preselectedMaVatTu) {
      selectMat.value = preselectedMaVatTu;
    }
  }

  function syncSpoilageInfo() {
    const opt = selectMat.options[selectMat.selectedIndex];
    if (opt) {
      const dvt = opt.getAttribute('data-dvt') || '';
      const qty = Number(opt.getAttribute('data-qty') || 0);
      if (badgeUnit) badgeUnit.textContent = dvt;
      if (currentStockDisplay) currentStockDisplay.value = `${qty.toLocaleString('vi-VN')} ${dvt}`;
      updateSpoilagePreview();
    }
  }

  function updateSpoilagePreview() {
    const opt = selectMat.options[selectMat.selectedIndex];
    const unitPrice = opt ? parseFloat(opt.getAttribute('data-price') || 0) : 0;
    const qty = parseFloat(inputQty.value) || 0;
    if (preview) {
      preview.textContent = (qty * unitPrice).toLocaleString('vi-VN') + ' đ';
    }
  }

  selectMat.onchange = syncSpoilageInfo;
  inputQty.oninput = updateSpoilagePreview;

  if (inputQty) inputQty.value = '';
  syncSpoilageInfo();

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}


function closeSpoilageModal() {
  document.getElementById('modal-spoilage')?.classList.add('hidden');
}

// Xử lý gửi Form Nhập Kho lên API
async function handleStockInSubmit(e) {
  e.preventDefault();
  const selectMat = document.getElementById('stockin-material-select');
  const selectSup = document.getElementById('stockin-supplier-select');
  const inputQty = document.getElementById('stockin-qty-input');
  const inputPrice = document.getElementById('stockin-price-input');
  const inputNotes = document.getElementById('stockin-notes-input');

  const maVatTu = selectMat?.value;
  const soLuong = parseFloat(inputQty?.value);
  const donGia = parseFloat(inputPrice?.value);
  const maNCC = selectSup?.value;
  const ghiChu = inputNotes?.value || '';

  if (!maVatTu || isNaN(soLuong) || soLuong <= 0) {
    showToast('Vui lòng nhập số lượng hợp lệ!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/inventory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maVatTu, soLuong, donGia, maNCC, ghiChu, maNhanVien: AppState.currentUser.maNhanVien })
    });
    const result = await res.json();
    if (result.success) {
      closeStockInModal();
      showToast(result.message || 'Nhập kho thành công!', 'success');
      if (window.playNotificationChime) window.playNotificationChime();
      await loadInventoryView();
    } else {
      showToast(result.message || 'Lỗi khi nhập kho', 'error');
    }
  } catch (err) {
    console.error('Lỗi nhập kho:', err);
    showToast('Không thể kết nối đến máy chủ', 'error');
  }
}

// Xử lý gửi Form Báo Hao Hụt lên API
async function handleSpoilageSubmit(e) {
  e.preventDefault();
  const selectMat = document.getElementById('spoilage-material-select');
  const inputQty = document.getElementById('spoilage-qty-input');
  const selectReason = document.getElementById('spoilage-reason-select');

  const maVatTu = selectMat?.value;
  const soLuong = parseFloat(inputQty?.value);
  const lyDo = selectReason?.value || 'Hao hụt kiểm kê';

  if (!maVatTu || isNaN(soLuong) || soLuong <= 0) {
    showToast('Vui lòng nhập số lượng hao hụt hợp lệ!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/inventory/spoilage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maVatTu, soLuong, lyDo, maNhanVien: AppState.currentUser.maNhanVien })
    });
    const result = await res.json();
    if (result.success) {
      closeSpoilageModal();
      showToast(result.message || 'Đã ghi nhận phiếu hao hụt!', 'warning');
      if (window.playNotificationChime) window.playNotificationChime();
      await loadInventoryView();
    } else {
      showToast(result.message || 'Lỗi ghi nhận hao hụt', 'error');
    }
  } catch (err) {
    console.error('Lỗi hao hụt:', err);
    showToast('Không thể kết nối đến máy chủ', 'error');
  }
}

window.openStockInModal = openStockInModal;
window.closeStockInModal = closeStockInModal;
window.openSpoilageModal = openSpoilageModal;
window.closeSpoilageModal = closeSpoilageModal;

async function openRecipesModal() {
  const container = document.getElementById('recipe-modal-list');
  if (!container) return;

  const res = await fetch('/api/inventory/recipes');
  const data = await res.json();
  if (data.success) {
    const grouped = {};
    data.data.forEach(r => {
      if (!grouped[r.TenMon]) grouped[r.TenMon] = [];
      grouped[r.TenMon].push(r);
    });

    let html = '';
    Object.keys(grouped).forEach(mon => {
      let ingredientsHtml = '';
      grouped[mon].forEach(ing => {
        ingredientsHtml += `
          <div class="flex items-center justify-between text-xs py-1.5 border-b border-slate-100">
            <span class="text-slate-700 font-medium">${ing.TenVatTu}</span>
            <span class="font-mono font-bold text-amber-700">${ing.SoLuongDinhMuc} ${ing.DonViTinh}</span>
          </div>
        `;
      });

      html += `
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
          <h4 class="font-bold text-sm text-slate-900 mb-2 flex items-center gap-2">
            ☕ ${mon}
          </h4>
          <div class="space-y-1">
            ${ingredientsHtml}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    document.getElementById('modal-recipes').classList.remove('hidden');
  }
}

// =====================================================================================
// CHẾ ĐỘ TẬP TRUNG (FOCUS MODE: ĐÓNG MỞ CÁC THANH CÔNG CỤ, CHỈ HIỂN THỊ NỘI DUNG CHÍNH)
// =====================================================================================
let isFocusModeActive = false;

function toggleFocusMode(forceState) {
  isFocusModeActive = forceState !== undefined ? forceState : !isFocusModeActive;
  const sidebar = document.getElementById('main-sidebar');
  const header = document.querySelector('header');
  const exitBtn = document.getElementById('btn-exit-focus-mode');

  if (isFocusModeActive) {
    sidebar?.classList.add('hidden');
    header?.classList.add('hidden');
    exitBtn?.classList.remove('hidden');
    showToast('Đã bật Chế độ Tập Trung (Nhấn ESC hoặc bấm nút nổi để thoát)', 'info');
  } else {
    sidebar?.classList.remove('hidden');
    header?.classList.remove('hidden');
    exitBtn?.classList.add('hidden');
    showToast('Đã thoát Chế độ Tập Trung', 'info');
  }
  if (window.lucide) window.lucide.createIcons();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFocusModeActive) {
    toggleFocusMode(false);
  }
});

// =====================================================================================
// LỊCH PHÂN CA LÀM VIỆC TUẦN (LICH_PHAN_CA CHO QUẢN LÝ & NHÂN VIÊN)
// =====================================================================================
let scheduleWeekOffset = 0;
let currentSchedules = [];

function getWeekDates(offsetWeeks = 0) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const distanceToMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - distanceToMonday + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function loadScheduleData() {
  const weekDays = getWeekDates(scheduleWeekOffset);
  const fromDate = formatDateISO(weekDays[0]);
  const toDate = formatDateISO(weekDays[6]);

  const displayEl = document.getElementById('schedule-week-display');
  if (displayEl) {
    const d1 = `${String(weekDays[0].getDate()).padStart(2, '0')}/${String(weekDays[0].getMonth() + 1).padStart(2, '0')}`;
    const d2 = `${String(weekDays[6].getDate()).padStart(2, '0')}/${String(weekDays[6].getMonth() + 1).padStart(2, '0')}/${weekDays[6].getFullYear()}`;
    displayEl.textContent = `Tuần: ${d1} - ${d2}`;
  }

  try {
    const res = await fetch(`/api/shifts/schedule?fromDate=${fromDate}&toDate=${toDate}`, {
      headers: { 'Authorization': `Bearer ${AppState.token || ''}` }
    });
    const data = await res.json();
    if (data.success) {
      currentSchedules = data.data || [];
      renderScheduleTable(weekDays);
    }
  } catch (err) {
    console.error('Lỗi khi nạp lịch phân ca:', err);
  }
}

function renderScheduleTable(weekDays) {
  const tbody = document.getElementById('schedule-matrix-tbody');
  if (!tbody) return;

  const headRow = document.getElementById('schedule-table-head-row');
  if (headRow) {
    const dayNames = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
    const todayStr = formatDateISO(new Date());

    headRow.innerHTML = `
      <th class="py-3 px-3 w-36 border-r border-slate-200 text-center bg-slate-100">Ca Làm Việc</th>
      ${weekDays.map((d, idx) => {
        const iso = formatDateISO(d);
        const isToday = iso === todayStr;
        const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        return `
          <th class="py-2.5 px-3 text-center border-r border-slate-200 ${isToday ? 'bg-teal-50 text-teal-900 border-b-2 border-b-teal-500' : ''}">
            <div class="font-extrabold">${dayNames[idx]}</div>
            <div class="text-[10px] font-mono ${isToday ? 'text-teal-700 font-bold' : 'text-slate-400 font-normal'}">${dateStr}</div>
          </th>
        `;
      }).join('')}
    `;
  }

  const shifts = [
    { code: 'CA_SANG', name: 'Ca Sáng', time: '06:30 - 12:00', badgeClass: 'bg-amber-50 text-amber-900 border-amber-300' },
    { code: 'CA_CHIEU', name: 'Ca Chiều', time: '12:00 - 17:30', badgeClass: 'bg-sky-50 text-sky-900 border-sky-300' },
    { code: 'CA_TOI', name: 'Ca Tối', time: '17:30 - 22:30', badgeClass: 'bg-indigo-50 text-indigo-900 border-indigo-300' }
  ];

  const canManage = AppState.currentRole === 'ChuQuan' || AppState.currentRole === 'QuanLy';

  let html = '';
  shifts.forEach(shift => {
    html += `
      <tr class="hover:bg-slate-50/50 transition">
        <td class="p-3 border-r border-slate-200 bg-slate-50/50 align-top">
          <span class="inline-block px-2 py-1 rounded-lg text-xs font-black border ${shift.badgeClass}">
            ${shift.name}
          </span>
          <span class="block text-[10px] text-slate-500 font-mono mt-1 font-medium">${shift.time}</span>
        </td>
    `;

    weekDays.forEach(d => {
      const dateStr = formatDateISO(d);
      const assigned = currentSchedules.filter(s => s.MaCa === shift.code && s.NgayLamViec === dateStr);

      html += `<td class="p-2 border-r border-slate-200 align-top min-h-[90px]"><div class="space-y-1.5">`;

      assigned.forEach(item => {
        const roleIcons = {
          ChuQuan: '👑',
          QuanLy: '👔',
          ThuNgan: '💵',
          PhaChe: '☕',
          PhucVu: '🍽️'
        };
        const roleIcon = roleIcons[item.VaiTro] || '👤';

        html += `
          <div class="p-1.5 rounded-xl bg-white border border-slate-200 shadow-2xs text-[11px] flex items-center justify-between group hover:border-teal-400 transition">
            <div class="min-w-0 flex-1 pr-1">
              <div class="font-bold text-slate-800 truncate flex items-center gap-1">
                <span>${roleIcon}</span>
                <span class="truncate">${item.HoTen}</span>
              </div>
              ${item.GhiChu ? `<span class="text-[9.5px] text-slate-400 italic block truncate">${item.GhiChu}</span>` : ''}
            </div>
            ${canManage ? `
              <button onclick="window.deleteScheduleItem('${item.MaPhanCa}')" class="text-slate-300 hover:text-rose-600 transition p-0.5 rounded opacity-0 group-hover:opacity-100 cursor-pointer shrink-0" title="Xóa ca này">
                ✕
              </button>
            ` : ''}
          </div>
        `;
      });

      if (canManage) {
        html += `
          <button onclick="window.openAssignScheduleModal('${dateStr}', '${shift.code}')" class="w-full py-1 text-[10px] text-slate-400 hover:text-teal-700 hover:bg-teal-50 border border-dashed border-slate-200 hover:border-teal-300 rounded-lg transition font-semibold flex items-center justify-center gap-1 cursor-pointer">
            + Xếp ca
          </button>
        `;
      }

      html += `</div></td>`;
    });

    html += `</tr>`;
  });

  tbody.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

async function openAssignScheduleModal(presetDate = '', presetShift = 'CA_SANG') {
  const modal = document.getElementById('modal-assign-schedule');
  const staffSelect = document.getElementById('assign-staff-select');
  const dateInput = document.getElementById('assign-date-input');
  const shiftSelect = document.getElementById('assign-shift-select');
  const noteInput = document.getElementById('assign-note-input');

  if (dateInput) {
    dateInput.value = presetDate || formatDateISO(new Date());
  }
  if (shiftSelect && presetShift) {
    shiftSelect.value = presetShift;
  }
  if (noteInput) noteInput.value = '';

  try {
    const res = await fetch('/api/employees');
    const data = await res.json();
    if (data.success && staffSelect) {
      let html = '';
      (data.data || []).forEach(emp => {
        html += `<option value="${emp.MaNhanVien}">${emp.HoTen} (${emp.VaiTro || emp.TenChucVu || 'Nhân viên'})</option>`;
      });
      staffSelect.innerHTML = html;
    }
  } catch (e) {}

  modal?.classList.remove('hidden');
}

async function submitAssignSchedule(e) {
  if (e) e.preventDefault();
  const maNhanVien = document.getElementById('assign-staff-select')?.value;
  const maCa = document.getElementById('assign-shift-select')?.value;
  const ngayLamViec = document.getElementById('assign-date-input')?.value;
  const ghiChu = document.getElementById('assign-note-input')?.value.trim();

  if (!maNhanVien || !maCa || !ngayLamViec) {
    showToast('Vui lòng chọn đủ nhân viên, ca làm và ngày!', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/shifts/schedule', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AppState.token || ''}`
      },
      body: JSON.stringify({ maNhanVien, maCa, ngayLamViec, ghiChu })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Đã xếp ca làm việc thành công!', 'success');
      document.getElementById('modal-assign-schedule')?.classList.add('hidden');
      await loadScheduleData();
    } else {
      showToast(data.message || 'Xếp ca thất bại!', 'error');
    }
  } catch (err) {
    showToast('Lỗi khi lưu ca làm việc!', 'error');
  }
}

async function deleteScheduleItem(id) {
  if (!confirm('Bạn có chắc muốn xóa ca phân công làm việc này?')) return;
  try {
    const res = await fetch(`/api/shifts/schedule/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AppState.token || ''}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Đã xóa ca phân công!', 'success');
      await loadScheduleData();
    } else {
      showToast(data.message || 'Xóa ca thất bại!', 'error');
    }
  } catch (err) {
    showToast('Lỗi khi xóa ca phân công!', 'error');
  }
}

// =====================================================================================
// MÓN NGOÀI MENU (CUSTOM AD-HOC ITEMS) & QUẢN LÝ MÓN MENU (DANH_MUC_MON)
// =====================================================================================

function handleImageFileUpload(file, callback) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Vui lòng chọn một file hình ảnh hợp lệ (PNG, JPG, WebP)!', 'warning');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Dung lượng ảnh tối đa là 5MB!', 'warning');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    callback(e.target.result);
  };
  reader.readAsDataURL(file);
}

function resetCustomItemImage() {
  const img = document.getElementById('custom-item-preview-img');
  const placeholder = document.getElementById('custom-item-preview-placeholder');
  const urlInput = document.getElementById('custom-item-image-url');
  const removeBtn = document.getElementById('btn-remove-custom-item-img');
  const fileInput = document.getElementById('custom-item-file-input');
  if (img) { img.src = ''; img.classList.add('hidden'); }
  if (placeholder) placeholder.classList.remove('hidden');
  if (urlInput) urlInput.value = '';
  if (removeBtn) removeBtn.classList.add('hidden');
  if (fileInput) fileInput.value = '';
}

function setCustomItemImage(url) {
  const img = document.getElementById('custom-item-preview-img');
  const placeholder = document.getElementById('custom-item-preview-placeholder');
  const urlInput = document.getElementById('custom-item-image-url');
  const removeBtn = document.getElementById('btn-remove-custom-item-img');
  if (img) { img.src = url; img.classList.remove('hidden'); }
  if (placeholder) placeholder.classList.add('hidden');
  if (urlInput) urlInput.value = url.startsWith('data:') ? '' : url;
  if (removeBtn) removeBtn.classList.remove('hidden');
}

function openCustomItemModal() {
  const currentTab = getCurrentTab();
  if (!currentTab) {
    showToast('Vui lòng chọn một bàn đang mở để thêm món!', 'warning');
    return;
  }
  document.getElementById('form-custom-menu-item')?.reset();
  resetCustomItemImage();
  const qtyEl = document.getElementById('custom-item-qty');
  if (qtyEl) qtyEl.value = '1';
  document.getElementById('modal-custom-menu-item')?.classList.remove('hidden');
  document.getElementById('custom-item-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

function submitCustomItem(e) {
  if (e) e.preventDefault();
  const currentTab = getCurrentTab();
  if (!currentTab) return;

  const name = document.getElementById('custom-item-name')?.value.trim();
  const price = parseFloat(document.getElementById('custom-item-price')?.value);
  const qty = parseInt(document.getElementById('custom-item-qty')?.value) || 1;
  const note = document.getElementById('custom-item-note')?.value.trim();

  if (!name || isNaN(price) || price <= 0) {
    showToast('Vui lòng nhập tên món và giá hợp lệ (> 0 đ)!', 'warning');
    return;
  }

  const previewImg = document.getElementById('custom-item-preview-img');
  const urlInput = document.getElementById('custom-item-image-url');
  let hinhAnh = '';
  if (previewImg && !previewImg.classList.contains('hidden') && previewImg.src) {
    hinhAnh = previewImg.src;
  } else if (urlInput && urlInput.value.trim()) {
    hinhAnh = urlInput.value.trim();
  }
  if (!hinhAnh) {
    hinhAnh = 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=400&auto=format&fit=crop&q=80';
  }

  const customId = `CUSTOM_${Date.now()}`;
  const customItem = {
    id: customId,
    maMon: customId,
    tenMon: name,
    donGia: price,
    soLuong: qty,
    sent_quantity: 0,
    kds_status: 'UNSENT',
    ghiChuTopping: note || '',
    ghiChu: note || 'Món ngoài menu',
    nhom: 'Món Tùy Chỉnh',
    hinhAnh: hinhAnh
  };

  currentTab.cart.push(customItem);
  renderTabCart();
  saveTabsToStorage();
  document.getElementById('modal-custom-menu-item')?.classList.add('hidden');
  showToast(`Đã thêm món "${name}" (${price.toLocaleString('vi-VN')} đ) vào đơn!`, 'success');
}

// -------------------------------------------------------------------------------------
// QUẢN LÝ / THÊM MÓN MỚI VÀO THỰC ĐƠN CHÍNH (DANH_MUC_MON)
// -------------------------------------------------------------------------------------

function resetMenuItemImage() {
  const img = document.getElementById('menu-editor-preview-img');
  const emptyBox = document.getElementById('menu-editor-preview-empty');
  const urlInput = document.getElementById('menu-editor-image-url');
  const removeBtn = document.getElementById('btn-remove-menu-editor-img');
  const fileInput = document.getElementById('menu-editor-file-input');
  if (img) { img.src = ''; img.classList.add('hidden'); }
  if (emptyBox) emptyBox.classList.remove('hidden');
  if (urlInput) urlInput.value = '';
  if (removeBtn) removeBtn.classList.add('hidden');
  if (fileInput) fileInput.value = '';
}

function setMenuItemImage(url) {
  const img = document.getElementById('menu-editor-preview-img');
  const emptyBox = document.getElementById('menu-editor-preview-empty');
  const urlInput = document.getElementById('menu-editor-image-url');
  const removeBtn = document.getElementById('btn-remove-menu-editor-img');
  if (img) { img.src = url; img.classList.remove('hidden'); }
  if (emptyBox) emptyBox.classList.add('hidden');
  if (urlInput) urlInput.value = url.startsWith('data:') ? '' : url;
  if (removeBtn) removeBtn.classList.remove('hidden');
}

function addMenuEditorIngredientRow(ing = null) {
  const container = document.getElementById('menu-editor-recipe-rows');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'menu-editor-ing-row bg-white p-2 sm:p-2.5 rounded-xl border border-amber-200/90 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center gap-2';

  const selectedMatId = ing ? (ing.MaVatTu || ing.maVatTu) : '';
  const selectedQty = ing ? (ing.SoLuongDinhMuc ?? ing.soLuongDinhMuc ?? 1) : '';
  const selectedUnit = ing ? (ing.DonViTinh || ing.donViTinh || 'g') : 'g';
  const selectedNote = ing ? (ing.GhiChu || ing.ghiChu || '') : '';

  let matOptions = '<option value="">-- Chọn nguyên vật liệu tiêu hao --</option>';
  (inventoryMaterialsData || []).forEach(m => {
    const isSel = m.MaVatTu === selectedMatId ? 'selected' : '';
    matOptions += `<option value="${m.MaVatTu}" data-unit="${m.DonViTinh || 'g'}" ${isSel}>${m.TenVatTu} (${m.DonViTinh || 'g'})</option>`;
  });

  row.innerHTML = `
    <div class="flex-1 min-w-0">
      <select class="ing-mat-select w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 focus:outline-none focus:border-amber-500">
        ${matOptions}
      </select>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      <input type="number" step="0.1" min="0.1" placeholder="Số lượng" value="${selectedQty}" class="ing-qty-input w-24 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono font-bold text-amber-800 focus:outline-none focus:border-amber-500 text-right">
      <span class="ing-unit-badge text-xs font-mono font-bold text-slate-600 w-12 text-center bg-slate-100 py-1.5 rounded-lg border border-slate-200 shrink-0">${selectedUnit}</span>
    </div>
    <div class="flex-1 flex items-center gap-1.5 min-w-0">
      <input type="text" placeholder="Ghi chú pha chế..." value="${selectedNote}" class="ing-note-input flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-amber-500">
      <button type="button" class="btn-del-ing-row p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition cursor-pointer shrink-0" title="Xóa nguyên liệu này">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>
  `;

  const matSelect = row.querySelector('.ing-mat-select');
  const unitBadge = row.querySelector('.ing-unit-badge');
  matSelect.addEventListener('change', () => {
    const opt = matSelect.options[matSelect.selectedIndex];
    const u = opt ? opt.getAttribute('data-unit') : 'g';
    if (unitBadge) unitBadge.textContent = u || 'g';
  });

  row.querySelector('.btn-del-ing-row')?.addEventListener('click', () => {
    row.remove();
  });

  container.appendChild(row);
  if (window.lucide) try { window.lucide.createIcons(); } catch (e) {}
}

async function openMenuItemEditor(maMon = null) {
  const modal = document.getElementById('modal-menu-item-editor');
  if (!modal) return;

  // Đảm bảo dữ liệu nguyên vật liệu kho đã được nạp
  if (!inventoryMaterialsData || inventoryMaterialsData.length === 0) {
    try {
      const res = await fetch('/api/inventory/materials');
      const data = await res.json();
      if (data.success) inventoryMaterialsData = data.data || [];
    } catch (e) {
      console.error('Lỗi tải danh sách nguyên vật liệu kho:', e);
    }
  }

  const title = document.getElementById('menu-editor-title');
  const form = document.getElementById('form-menu-item-editor');
  const idInput = document.getElementById('menu-editor-id');
  const nameInput = document.getElementById('menu-editor-name');
  const groupSelect = document.getElementById('menu-editor-group');
  const priceInput = document.getElementById('menu-editor-price');
  const unitSelect = document.getElementById('menu-editor-unit');
  const statusSelect = document.getElementById('menu-editor-status');
  const rowsContainer = document.getElementById('menu-editor-recipe-rows');

  resetMenuItemImage();
  if (rowsContainer) rowsContainer.innerHTML = '';

  if (maMon) {
    const item = AppState.menuItems.find(m => m.MaMon === maMon);
    if (!item) return;

    if (title) title.textContent = `Chỉnh Sửa Món & Công Thức: ${item.TenMon} (${item.MaMon})`;
    if (idInput) idInput.value = item.MaMon;
    if (nameInput) nameInput.value = item.TenMon;
    if (groupSelect) groupSelect.value = item.MaNhom;
    if (priceInput) priceInput.value = item.GiaBanHienHanh;
    if (unitSelect) unitSelect.value = item.DonViTinh || 'Ly';
    if (statusSelect) statusSelect.value = item.DangKinhDoanh !== undefined ? String(item.DangKinhDoanh) : '1';

    if (item.HinhAnh) {
      setMenuItemImage(item.HinhAnh);
    }

    // Tải công thức hiện tại của món
    try {
      const recRes = await fetch(`/api/inventory/recipes?maMon=${encodeURIComponent(maMon)}`);
      const recData = await recRes.json();
      if (recData.success && Array.isArray(recData.data) && recData.data.length > 0) {
        recData.data.forEach(ing => addMenuEditorIngredientRow(ing));
      } else {
        addMenuEditorIngredientRow();
      }
    } catch (e) {
      console.error('Lỗi tải công thức món:', e);
      addMenuEditorIngredientRow();
    }
  } else {
    if (title) title.textContent = 'Thêm Món & Công Thức Mới Vào Menu';
    if (form) form.reset();
    if (idInput) idInput.value = '';
    if (priceInput) priceInput.value = '35000';
    if (statusSelect) statusSelect.value = '1';
    addMenuEditorIngredientRow();
  }

  modal.classList.remove('hidden');
  if (window.lucide) try { window.lucide.createIcons(); } catch (e) {}
}

async function handleMenuItemSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('menu-editor-id')?.value;
  const tenMon = document.getElementById('menu-editor-name')?.value.trim();
  const maNhom = document.getElementById('menu-editor-group')?.value;
  const giaBanHienHanh = parseFloat(document.getElementById('menu-editor-price')?.value);
  const donViTinh = document.getElementById('menu-editor-unit')?.value;
  const dangKinhDoanh = parseInt(document.getElementById('menu-editor-status')?.value || '1');

  if (!tenMon || isNaN(giaBanHienHanh) || giaBanHienHanh < 0) {
    showToast('Vui lòng nhập tên món và giá bán hợp lệ!', 'warning');
    return;
  }

  const previewImg = document.getElementById('menu-editor-preview-img');
  const urlInput = document.getElementById('menu-editor-image-url');
  let hinhAnh = '';
  if (previewImg && !previewImg.classList.contains('hidden') && previewImg.src) {
    hinhAnh = previewImg.src;
  } else if (urlInput && urlInput.value.trim()) {
    hinhAnh = urlInput.value.trim();
  }
  if (!hinhAnh) {
    hinhAnh = 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=400&auto=format&fit=crop&q=80';
  }

  // Thu thập danh sách nguyên liệu định mức từ form
  const ingRows = document.querySelectorAll('#menu-editor-recipe-rows .menu-editor-ing-row');
  const ingredients = [];
  ingRows.forEach(r => {
    const vId = r.querySelector('.ing-mat-select')?.value;
    const qty = parseFloat(r.querySelector('.ing-qty-input')?.value);
    const unit = r.querySelector('.ing-unit-badge')?.textContent?.trim() || 'g';
    const note = r.querySelector('.ing-note-input')?.value?.trim() || '';
    if (vId && !isNaN(qty) && qty > 0) {
      ingredients.push({ maVatTu: vId, soLuongDinhMuc: qty, donViTinh: unit, ghiChu: note });
    }
  });

  const btn = document.getElementById('btn-submit-menu-editor');
  if (btn) btn.disabled = true;

  try {
    const payload = { tenMon, maNhom, donViTinh, giaBanHienHanh, hinhAnh, dangKinhDoanh, ingredients };
    const url = id ? `/api/menu/items/${id}` : '/api/menu/items';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-user-role': AppState.currentRole
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(data.message || (id ? 'Đã cập nhật món & công thức thành công!' : 'Đã thêm món & công thức mới vào thực đơn!'), 'success');
    document.getElementById('modal-menu-item-editor')?.classList.add('hidden');

    // Tải lại Menu và cập nhật giao diện quầy POS & Recipe
    await loadMenu();
    if (typeof loadBaristaRecipes === 'function') {
      await loadBaristaRecipes();
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteMenuItem(maMon) {
  const item = AppState.menuItems.find(m => m.MaMon === maMon);
  const name = item ? item.TenMon : maMon;

  if (!confirm(`Bạn có chắc chắn muốn xóa món "${name}" (${maMon}) khỏi thực đơn không?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/menu/items/${maMon}`, {
      method: 'DELETE',
      headers: {
        'x-user-role': AppState.currentRole
      }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(data.message || `Đã xóa món "${name}"!`, 'success');
    await loadMenu();
    if (typeof loadBaristaRecipes === 'function') {
      await loadBaristaRecipes();
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}
window.deleteMenuItem = deleteMenuItem;
window.addMenuEditorIngredientRow = addMenuEditorIngredientRow;

async function openCancelHistoryModal() {
  const modal = document.getElementById('modal-cancel-history');
  const tbody = document.getElementById('cancel-history-tbody');
  if (!modal || !tbody) return;

  tbody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-slate-400">Đang tải lịch sử...</td></tr>';
  modal.classList.remove('hidden');

  try {
    const res = await fetch('/api/orders/cancellations', {
      headers: { 'Authorization': `Bearer ${AppState.token || ''}` }
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      if (data.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-slate-400">Chưa có lịch sử hủy món hoặc thay đổi nào.</td></tr>';
        return;
      }

      let html = '';
      data.data.forEach(item => {
        const timeStr = item.NgayGioHuy ? new Date(item.NgayGioHuy).toLocaleString('vi-VN') : '---';
        const priceStr = item.DonGia ? `${Number(item.DonGia).toLocaleString('vi-VN')} đ` : '0 đ';
        html += `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${timeStr}</td>
            <td class="py-2.5 px-3 font-mono font-bold text-slate-700 whitespace-nowrap">${item.SoHoaDon}</td>
            <td class="py-2.5 px-3 font-bold text-slate-900">${item.TenMon}</td>
            <td class="py-2.5 px-3 text-center font-mono font-bold text-amber-700">${item.SoLuong}</td>
            <td class="py-2.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">${priceStr}</td>
            <td class="py-2.5 px-3 text-slate-600 italic">${item.LyDoHuy || 'Khách đổi ý'}</td>
            <td class="py-2.5 px-3 text-slate-700 font-medium">${item.TenNguoiYeuCau || item.NguoiYeuCau || 'Nhân viên'}</td>
            <td class="py-2.5 px-3 text-slate-800 font-bold">${item.TenNguoiPheDuyet || item.NguoiPheDuyet || 'Quản lý'} (${item.VaiTroPheDuyet || 'QuanLy'})</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">Đã Duyệt</span>
            </td>
          </tr>
        `;
      });
      tbody.innerHTML = html;
    } else {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-rose-500">Không thể tải dữ liệu lịch sử hủy món.</td></tr>';
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-rose-500">Lỗi kết nối máy chủ!</td></tr>';
  }
}

// =====================================================================================
// ĐĂNG KÝ TÀI KHOẢN (REGISTRATION HANDLERS)
// =====================================================================================
function openRegisterModal() {
  document.getElementById('modal-login')?.classList.add('hidden');
  const regModal = document.getElementById('modal-register');
  if (regModal) regModal.classList.remove('hidden');
  const alert = document.getElementById('reg-error-alert');
  if (alert) alert.classList.add('hidden');
}

function closeRegisterModal() {
  document.getElementById('modal-register')?.classList.add('hidden');
}

async function handleRegisterSubmit(e) {
  if (e) e.preventDefault();
  const hoTen = document.getElementById('reg-fullname')?.value.trim();
  const soDienThoai = document.getElementById('reg-phone')?.value.trim();
  const vaiTro = document.getElementById('reg-role')?.value;
  const tenDangNhap = document.getElementById('reg-username')?.value.trim();
  const matKhau = document.getElementById('reg-password')?.value.trim();
  const errorAlert = document.getElementById('reg-error-alert');
  const errorText = document.getElementById('reg-error-text');
  const submitBtn = document.getElementById('btn-submit-register');

  if (!hoTen || !soDienThoai || !vaiTro || !tenDangNhap || !matKhau) {
    if (errorAlert && errorText) {
      errorText.textContent = 'Vui lòng điền đầy đủ các thông tin!';
      errorAlert.classList.remove('hidden');
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await _nativeFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hoTen, soDienThoai, vaiTro, tenDangNhap, matKhau })
    });
    const data = await res.json();
    if (data.success && data.data) {
      const { token, user } = data.data;
      localStorage.setItem('pho_xanh_token', token);
      localStorage.setItem('pho_xanh_user', JSON.stringify(user));
      localStorage.setItem('pho_xanh_user_role', user.vaiTro);

      AppState.token = token;
      AppState.currentUser = user;
      AppState.currentRole = user.vaiTro;

      closeRegisterModal();
      applyRolePermissions(user.vaiTro, false);

      const defaultLandingTab = {
        ChuQuan: 'pos',
        QuanLy: 'pos',
        PhaChe: 'kds',
        ThuNgan: 'pos'
      }[user.vaiTro] || 'pos';

      navigateToTab(defaultLandingTab, true);
      showToast(`🎉 ${data.message}`, 'success');
    } else {
      if (errorAlert && errorText) {
        errorText.textContent = data.message || 'Đăng ký tài khoản thất bại!';
        errorAlert.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (errorAlert && errorText) {
      errorText.textContent = 'Không thể kết nối đến máy chủ!';
      errorAlert.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Global Exports
window.toggleFocusMode = toggleFocusMode;
window.openMergeTableModal = openMergeTableModal;
window.confirmTableMerge = confirmTableMerge;
window.openAssignScheduleModal = openAssignScheduleModal;
window.deleteScheduleItem = deleteScheduleItem;
window.openCustomItemModal = openCustomItemModal;
window.openCancelHistoryModal = openCancelHistoryModal;
window.switchKdsViewMode = switchKdsViewMode;
window.openRegisterModal = openRegisterModal;
window.closeRegisterModal = closeRegisterModal;
window.handleRegisterSubmit = handleRegisterSubmit;

// =====================================================================================
// RBAC ROLE PERMISSIONS (CHUẨN HÓA SƠ ĐỒ USE CASE HÌNH 1 & ERD HÌNH 2)
// 1. Chủ Quán (Owner) - Toàn quyền tối cao hệ thống, xem P&L, phê duyệt hủy món, quản trị
// 2. Quản Lý (Admin) - Toàn quyền quản trị chi nhánh, P&L, Kho, Nhân sự, Phê duyệt hủy món
// 3. Thu Ngân (Cashier) - Tạo đơn POS, Sơ đồ bàn/Mang đi, Voucher, Tích điểm, Thanh toán, In bill, Chốt ca
// 4. Pha Chế (Barista) - CHỈ xem màn hình chờ KDS, Cập nhật trạng thái món, Xem công thức pha chế
// =====================================================================================
function applyRolePermissions(role, shouldRedirect = true) {
  let normalizedRole = role;
  if (role === 'Admin') normalizedRole = 'QuanLy';
  if (role === 'PhucVu') normalizedRole = 'ThuNgan';
  AppState.currentRole = normalizedRole;
  try { localStorage.setItem('pho_xanh_user_role', normalizedRole); } catch (e) {}

  const roleIcons = {
    ChuQuan: '👑',
    QuanLy: '👨‍💼',
    ThuNgan: '💵',
    PhaChe: '☕'
  };
  const roleBadges = {
    ChuQuan: 'Chủ Quán (Owner)',
    QuanLy: 'Quản Lý (Admin)',
    ThuNgan: 'Thu Ngân (Cashier)',
    PhaChe: 'Pha Chế (Barista)',
    PhucVu: 'Phục Vụ (Waiter)'
  };

  const badgeIconEl = document.getElementById('sidebar-role-badge-icon');
  if (badgeIconEl) badgeIconEl.textContent = roleIcons[normalizedRole] || '👨‍💼';

  const miniIconEl = document.getElementById('sidebar-role-mini-icon');
  if (miniIconEl) miniIconEl.textContent = roleIcons[normalizedRole] || '👨‍💼';

  const roleBadgeEl = document.getElementById('current-user-role-badge');
  if (roleBadgeEl) roleBadgeEl.textContent = roleBadges[normalizedRole] || normalizedRole;

  // Đồng bộ thông tin nhân viên đăng nhập & ID tương ứng trong CSDL
  const roleUsers = {
    ChuQuan: { maNhanVien: 'NV01', hoTen: 'Nguyễn Hoàng Nam', tenDangNhap: 'owner', vaiTro: 'ChuQuan' },
    QuanLy: { maNhanVien: 'NV02', hoTen: 'Trần Minh Tuấn', tenDangNhap: 'manager', vaiTro: 'QuanLy' },
    ThuNgan: { maNhanVien: 'NV03', hoTen: 'Lê Thị Mai', tenDangNhap: 'cashier', vaiTro: 'ThuNgan' },
    PhaChe: { maNhanVien: 'NV04', hoTen: 'Phạm Đăng Khoa', tenDangNhap: 'barista', vaiTro: 'PhaChe' }
  };
  if (!AppState.currentUser && roleUsers[normalizedRole]) {
    AppState.currentUser = roleUsers[normalizedRole];
  }
  if (AppState.currentUser) {
    const nameEl = document.getElementById('current-user-name');
    if (nameEl) {
      const cleanName = (AppState.currentUser.hoTen || '').replace(/\s*\([^)]*\)$/, '').trim();
      nameEl.textContent = cleanName || AppState.currentUser.hoTen;
      nameEl.title = AppState.currentUser.hoTen;
    }
  }

  // ẨN / HIỆN NÚT THÊM NHÂN VIÊN: CHỦ QUÁN & QUẢN LÝ ĐƯỢC PHÉP THÊM / SỬA / XÓA NHÂN SỰ
  const addStaffBtn = document.getElementById('btn-open-add-staff-modal');
  if (addStaffBtn) {
    if (normalizedRole === 'ChuQuan' || normalizedRole === 'QuanLy') {
      addStaffBtn.classList.remove('hidden');
    } else {
      addStaffBtn.classList.add('hidden');
    }
  }

  // DANH SÁCH TAB ĐƯỢC PHÉP TRUY CẬP CHO TỪNG VAI TRÒ
  const allowedTabs = {
    ChuQuan: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    QuanLy: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    PhaChe: ['kds', 'recipes', 'schedule'],
    ThuNgan: ['pos', 'shift', 'schedule', 'printer']
  };

  const currentAllowed = allowedTabs[normalizedRole] || ['pos'];

  document.querySelectorAll('.nav-tab').forEach(tabBtn => {
    const tabName = tabBtn.getAttribute('data-tab');
    if (currentAllowed.includes(tabName)) {
      tabBtn.classList.remove('hidden');
    } else {
      tabBtn.classList.add('hidden');
    }
  });

  if (shouldRedirect && !currentAllowed.includes(AppState.activeMainTab)) {
    navigateToTab(currentAllowed[0], true);
  }
}

// =====================================================================================
// FRONTEND URL ROUTING & NAVIGATION (MỖI TAB LÀ MỘT URL RIÊNG BIỆT)
// =====================================================================================
function getTabFromPath() {
  const path = window.location.pathname.replace(/^\/+/, '').split('/')[0].toLowerCase();
  const validTabs = ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'shift', 'reports', 'printer'];
  return validTabs.includes(path) ? path : null;
}

function getMainTabTitle(tabName) {
  const titles = {
    pos: 'BÁN HÀNG (POS)',
    kds: 'BẾP & PHA CHẾ (KDS)',
    recipes: 'CÔNG THỨC PHA CHẾ',
    inventory: 'KHO NGUYÊN LIỆU',
    staff: 'NHÂN SỰ & BẢNG LƯƠNG',
    schedule: 'LỊCH PHÂN CA LÀM VIỆC',
    shift: 'CHỐT CA & KÉT TIỀN',
    reports: 'BÁO CÁO LÃI - LỖ (P&L)',
    printer: 'MÁY IN HÓA ĐƠN K80'
  };
  return titles[tabName] || 'HỆ THỐNG POS';
}

function navigateToTab(tabName, pushState = true) {
  if (!tabName) tabName = 'pos';

  const allowedTabs = {
    ChuQuan: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    QuanLy: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    PhaChe: ['kds', 'recipes', 'schedule'],
    ThuNgan: ['pos', 'shift', 'schedule', 'printer']
  };

  const currentRole = AppState.currentRole || 'QuanLy';
  const currentAllowed = allowedTabs[currentRole] || ['pos'];

  if (!currentAllowed.includes(tabName)) {
    const roleTitles = {
      PhaChe: 'Pha Chế',
      ThuNgan: 'Thu Ngân',
      QuanLy: 'Quản Lý',
      ChuQuan: 'Chủ Quán'
    };
    showToast(`⛔ Tài khoản ${roleTitles[currentRole] || currentRole} không có quyền truy cập tab "${getMainTabTitle(tabName)}"!`, 'error');
    const fallbackTab = currentAllowed[0] || 'pos';
    applyTabPaneSwitch(fallbackTab);
    if (pushState && window.location.pathname !== `/${fallbackTab}`) {
      try { window.history.replaceState({ tab: fallbackTab }, '', `/${fallbackTab}`); } catch (e) {}
    }
    return;
  }

  applyTabPaneSwitch(tabName);
  if (pushState && window.location.pathname !== `/${tabName}`) {
    try {
      window.history.pushState({ tab: tabName }, '', `/${tabName}`);
    } catch (e) {}
  }
  document.title = `Phố Xanh Coffee | ${getMainTabTitle(tabName)}`;
}

function switchMainTab(tabName) {
  navigateToTab(tabName, true);
}

function applyTabPaneSwitch(tabName) {
  AppState.activeMainTab = tabName;

  const titles = {
    pos: 'BÁN HÀNG (POS)',
    kds: 'BẾP & PHA CHẾ (KDS)',
    recipes: 'THỰC ĐƠN & CÔNG THỨC',
    inventory: 'KHO NGUYÊN LIỆU',
    staff: 'NHÂN SỰ & BẢNG LƯƠNG',
    schedule: 'LỊCH PHÂN CA LÀM VIỆC',
    shift: 'CHỐT CA & KÉT TIỀN',
    reports: 'BÁO CÁO LÃI - LỖ (P&L)',
    printer: 'MÁY IN HÓA ĐƠN K80'
  };

  const headerTitle = document.getElementById('main-header-title');
  if (headerTitle) headerTitle.textContent = titles[tabName] || 'HỆ THỐNG BÁN HÀNG';
  if (typeof setHeaderVisibility === 'function') setHeaderVisibility(true);

  // Điều khiển ẩn/hiện nút nổi giỏ hàng theo tab chính
  const floatBtn = document.getElementById('btn-floating-pos-cart');
  if (floatBtn) {
    if (tabName === 'pos') {
      const cur = typeof getCurrentTab === 'function' ? getCurrentTab() : null;
      if (cur && cur.id !== 'floor') {
        floatBtn.classList.remove('hidden');
      } else {
        floatBtn.classList.add('hidden');
      }
    } else {
      floatBtn.classList.add('hidden');
    }
  }

  const allowedTabs = {
    ChuQuan: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    QuanLy: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
    PhaChe: ['kds', 'recipes', 'schedule'],
    ThuNgan: ['pos', 'shift', 'schedule', 'printer']
  };
  const currentRole = AppState.currentRole || 'QuanLy';
  const currentAllowed = allowedTabs[currentRole] || ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'];

  document.querySelectorAll('.nav-tab').forEach(btn => {
    const isCollapsed = AppState.isSidebarCollapsed;
    const justifyClass = isCollapsed ? 'justify-center' : '';
    const t = btn.getAttribute('data-tab');
    const isAllowed = currentAllowed.includes(t);
    const hiddenClass = isAllowed ? '' : 'hidden';

    if (t === tabName) {
      btn.className = `nav-tab active-tab block w-full px-2.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-2.5 cursor-pointer ${justifyClass} ${hiddenClass}`.trim();
    } else {
      btn.className = `nav-tab block w-full px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2.5 cursor-pointer ${justifyClass} ${hiddenClass}`.trim();
    }
  });

  const panes = ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'shift', 'reports', 'printer'];
  panes.forEach(p => {
    const paneEl = document.getElementById(`tab-pane-${p}`);
    if (paneEl) {
      if (p === tabName) {
        paneEl.classList.remove('hidden');
        paneEl.style.display = 'flex';
        paneEl.classList.remove('animate-fade-in');
        void paneEl.offsetWidth;
        paneEl.classList.add('animate-fade-in');
      } else {
        paneEl.classList.add('hidden');
        paneEl.style.display = 'none';
      }
    }
  });

  try {
    if (tabName === 'reports') loadProfitAndLoss();
    if (tabName === 'inventory') loadInventoryView();
    if (tabName === 'staff') loadStaffData();
    if (tabName === 'recipes') loadBaristaRecipes();
    if (tabName === 'shift') loadShiftData();
    if (tabName === 'schedule') loadScheduleData();
    if (tabName === 'kds') {
      loadKdsTickets();
      if (currentKdsViewMode === 'batch') renderKdsBatchMode();
    }
    if (tabName === 'pos') {
      renderPosTableTabs();
      renderFloorTables();
    }
  } catch (err) {
    console.error('Lỗi khi nạp dữ liệu tab:', tabName, err);
  }

  if (window.lucide) {
    try { window.lucide.createIcons(); } catch (e) {}
  }

  // Đóng drawer trên thiết bị di động sau khi chọn tab
  if (window.innerWidth < 1024) {
    toggleMobileSidebar(true);
  }
}

window.AppState = AppState;
window.applyTabPaneSwitch = applyTabPaneSwitch;
window.navigateToTab = navigateToTab;
window.switchMainTab = switchMainTab;
window.applyRolePermissions = applyRolePermissions;
window.confirmCancelWithApproval = confirmCancelWithApproval;

// Bật / tắt thanh công cụ dạng Drawer trên màn hình Điện thoại & Tablet
function toggleMobileSidebar(forceClose = false) {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar || !backdrop) return;

  if (forceClose || sidebar.classList.contains('mobile-open')) {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.add('hidden');
  } else {
    sidebar.classList.add('mobile-open');
    backdrop.classList.remove('hidden');
  }
}

// =====================================================================================
// STAFF MANAGEMENT & SHIFT PAYROLL (QUẢN LÝ NHÂN SỰ & TÍNH LƯƠNG CHẤM CA 23 BẢNG)
// =====================================================================================
// staffEmployeesList defined at top
// staffMetadata defined at top
// staffShiftsList defined at top
// staffActiveSubtab defined at top

function switchStaffSubtab(subtab) {
  staffActiveSubtab = subtab;

  document.querySelectorAll('.staff-subnav-btn').forEach(b => {
    b.className = 'staff-subnav-btn px-4 py-2 rounded-xl text-xs font-bold transition bg-white text-slate-600 hover:bg-slate-100 border border-slate-200 cursor-pointer flex items-center gap-1.5 shrink-0';
  });
  const activeBtn = document.querySelector(`.staff-subnav-btn[data-staff-subtab="${subtab}"]`);
  if (activeBtn) {
    activeBtn.className = 'staff-subnav-btn px-4 py-2 rounded-xl text-xs font-bold transition bg-slate-900 text-white shadow-md transform -translate-y-0.5 cursor-pointer flex items-center gap-1.5 shrink-0';
  }

  const subpanes = ['employees', 'payroll', 'timekeeping', 'shifts', 'matrix'];
  subpanes.forEach(p => {
    const pane = document.getElementById(`staff-subpane-${p}`);
    if (pane) {
      if (p === subtab) {
        pane.classList.remove('hidden');
        pane.style.display = 'block';
      } else {
        pane.classList.add('hidden');
        pane.style.display = 'none';
      }
    }
  });
  if (subtab === 'shifts') {
    loadShiftConfigs();
  }
  if (window.lucide) {
    try { window.lucide.createIcons(); } catch (e) {}
  }
}
window.switchStaffSubtab = switchStaffSubtab;

async function loadStaffData() {
  try {
    const [empRes, metaRes, payrollRes, timeRes] = await Promise.all([
      fetch('/api/employees'),
      fetch('/api/employees/metadata'),
      fetch('/api/payroll/summary'),
      fetch('/api/payroll/timekeeping')
    ]);

    const [empData, metaData, payrollData, timeData] = await Promise.all([
      empRes.json(),
      metaRes.json(),
      payrollRes.json(),
      timeRes.json()
    ]);

    if (metaData.success) {
      staffMetadata = {
        chucVu: metaData.data.chucVu || metaData.data.chucVuList || [],
        boPhan: metaData.data.boPhan || metaData.data.boPhanList || [],
        caLamViec: metaData.data.caLamViec || metaData.data.caLamViecList || []
      };
      populateStaffFormMetadata();
    }

    if (empData.success) {
      staffEmployeesList = empData.data;
      renderStaffListTable(staffEmployeesList);
      const totalEl = document.getElementById('staff-kpi-total');
      if (totalEl) totalEl.textContent = staffEmployeesList.length;
    }

    if (payrollData.success) {
      const items = Array.isArray(payrollData.data) ? payrollData.data : (payrollData.data.items || []);
      const totalShifts = items.reduce((sum, i) => sum + (i.TongSoCa !== undefined ? i.TongSoCa : (i.soCa || 0)), 0);
      const totalPayroll = items.reduce((sum, i) => sum + (i.thucLinh || 0), 0);
      const shiftsEl = document.getElementById('staff-kpi-shifts');
      if (shiftsEl) shiftsEl.textContent = `${totalShifts} ca`;
      const salaryEl = document.getElementById('staff-kpi-total-salary');
      if (salaryEl) salaryEl.textContent = `${totalPayroll.toLocaleString('vi-VN')} đ`;
      renderStaffPayrollTable(items);
    }

    if (timeData.success) {
      renderStaffTimekeepingTable(timeData.data || []);
    }

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('Lỗi nạp danh sách nhân sự:', err);
  }
}

function renderStaffListTable(employees) {
  const tbody = document.getElementById('staff-list-tbody');
  if (!tbody) return;

  const roleBadges = {
    ChuQuan: '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs whitespace-nowrap leading-none"><span class="text-xs leading-none shrink-0">👑</span><span>Chủ Quán (Admin)</span></span>',
    QuanLy: '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-purple-100 text-purple-900 border border-purple-300 shadow-2xs whitespace-nowrap leading-none"><span class="text-xs leading-none shrink-0">👔</span><span>Quản Lý (Admin)</span></span>',
    ThuNgan: '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300 shadow-2xs whitespace-nowrap leading-none"><span class="text-xs leading-none shrink-0">💵</span><span>Thu Ngân (Cashier)</span></span>',
    PhaChe: '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-sky-100 text-sky-900 border border-sky-300 shadow-2xs whitespace-nowrap leading-none"><span class="text-xs leading-none shrink-0">☕</span><span>Pha Chế (Barista)</span></span>',
    PhucVu: '<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-800 border border-slate-300 shadow-2xs whitespace-nowrap leading-none"><span class="text-xs leading-none shrink-0">🛎️</span><span>Phục Vụ</span></span>'
  };

  let html = '';
  employees.forEach(emp => {
    const isWorking = (emp.TrangThaiLamViec || emp.TrangThaiHoatDong) === 'DangLamViec' && emp.KichHoat !== 0;
    const statusHtml = isWorking
      ? '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap leading-none"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span><span>Đang làm việc</span></span>'
      : '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 whitespace-nowrap leading-none"><span class="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0"></span><span>Nghỉ việc</span></span>';

    const canManage = AppState.currentRole === 'ChuQuan' || AppState.currentRole === 'QuanLy';

    html += `
      <tr class="hover:bg-indigo-50/30 transition">
        <td class="py-3 px-4 align-middle whitespace-nowrap">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 font-extrabold flex items-center justify-center shrink-0 text-xs shadow-2xs">
              ${(emp.HoTen || 'NV').split(' ').pop().slice(0, 2).toUpperCase()}
            </div>
            <div>
              <span class="font-extrabold text-slate-900 text-xs">${emp.HoTen}</span>
              <span class="block text-[10px] font-mono text-indigo-700 font-bold">${emp.MaNhanVien} ${emp.TenDangNhap ? `• @${emp.TenDangNhap}` : ''}</span>
            </div>
          </div>
        </td>
        <td class="py-3 px-4 align-middle whitespace-nowrap font-mono font-bold text-slate-700 text-xs">${emp.SoDienThoai || '---'}</td>
        <td class="py-3 px-4 align-middle whitespace-nowrap text-slate-800 font-semibold text-xs">${emp.TenChucVu || emp.MaChucVu}</td>
        <td class="py-3 px-4 align-middle whitespace-nowrap text-slate-600 text-xs">${emp.TenBoPhan || emp.MaBoPhan}</td>
        <td class="py-3 px-4 align-middle whitespace-nowrap">${roleBadges[emp.VaiTro] || `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200 whitespace-nowrap leading-none">${emp.VaiTro}</span>`}</td>
        <td class="py-3 px-4 align-middle whitespace-nowrap text-center">${statusHtml}</td>
        <td class="py-3 px-4 align-middle whitespace-nowrap text-center">
          ${canManage ? `
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="window.openTimekeepingModal('${emp.MaNhanVien}')" class="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-[11px] font-bold border border-emerald-200 transition cursor-pointer" title="Chấm ca làm việc">
                + Chấm ca
              </button>
              <button onclick="window.openStaffModal('${emp.MaNhanVien}')" class="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-[11px] font-bold border border-indigo-200 transition cursor-pointer" title="Sửa thông tin">
                Sửa
              </button>
              ${emp.MaNhanVien !== 'NV01' ? `
                <button onclick="window.deleteStaff('${emp.MaNhanVien}', '${emp.HoTen}')" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-bold border border-rose-200 transition cursor-pointer" title="Xóa nhân viên">
                  Xóa
                </button>
              ` : ''}
            </div>
          ` : `
            <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200" title="Chỉ Chủ Quán / Quản Lý mới có quyền quản trị nhân sự">
              Chỉ xem
            </span>
          `}
        </td>
      </tr>
    `;
  });

  if (employees.length === 0) {
    html = `<tr><td colspan="7" class="text-center py-8 text-slate-400">Chưa có nhân viên nào trong hệ thống.</td></tr>`;
  }
  tbody.innerHTML = html;
}

function renderStaffPayrollTable(items) {
  const tbody = document.getElementById('staff-payroll-tbody');
  if (!tbody) return;

  let html = '';
  items.forEach(p => {
    const shiftCount = p.TongSoCa !== undefined ? p.TongSoCa : (p.soCa || 0);
    const wagePerShift = p.luongMoiCa || p.luongTieuChuanCa || 200000;
    const totalShiftWage = p.TongLuongCa !== undefined ? p.TongLuongCa : (p.tongLuongCa || 0);
    const allowance = p.phuCap !== undefined ? p.phuCap : (p.phuCapTrachNhiem || 0);
    const netSalary = p.thucLinh !== undefined ? p.thucLinh : (totalShiftWage + allowance);

    html += `
      <tr class="hover:bg-amber-50/30 transition">
        <td class="py-3 px-4">
          <span class="font-extrabold text-slate-900 text-xs block">${p.HoTen}</span>
          <span class="text-[10px] text-slate-500 font-mono">${p.MaNhanVien} • ${p.TenChucVu}</span>
        </td>
        <td class="py-3 px-4 text-slate-700 text-xs">${p.TenBoPhan}</td>
        <td class="py-3 px-4 text-center">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-mono font-black ${shiftCount > 0 ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-slate-100 text-slate-500'}">
            ${shiftCount} ca
          </span>
        </td>
        <td class="py-3 px-4 text-right font-mono text-slate-600">${wagePerShift.toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-right font-mono font-bold text-slate-800">${totalShiftWage.toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-right font-mono text-slate-600">+${allowance.toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-right font-mono font-black text-emerald-600 text-sm">${netSalary.toLocaleString('vi-VN')} đ</td>
        <td class="py-3 px-4 text-center">
          <button onclick="window.openTimekeepingModal('${p.MaNhanVien}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-xs cursor-pointer">
            + Chấm ca
          </button>
        </td>
      </tr>
    `;
  });

  if (items.length === 0) {
    html = `<tr><td colspan="8" class="text-center py-8 text-slate-400">Chưa có dữ liệu bảng lương tháng này.</td></tr>`;
  }
  tbody.innerHTML = html;
}

function renderStaffTimekeepingTable(logs) {
  const tbody = document.getElementById('staff-timekeeping-tbody');
  if (!tbody) return;

  let html = '';
  logs.forEach(log => {
    html += `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-4 font-mono font-bold text-slate-800 text-xs">
          ${log.NgayChamCong}
        </td>
        <td class="py-3 px-4">
          <span class="font-extrabold text-slate-900 text-xs block">${log.HoTen}</span>
          <span class="text-[10px] text-slate-500 font-mono">${log.MaNhanVien} • ${log.TenChucVu}</span>
        </td>
        <td class="py-3 px-4 text-slate-700 text-xs font-semibold">
          <span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-800 border border-indigo-100 font-mono text-[11px]">
            ${log.TenCa || log.MaCa}
          </span>
        </td>
        <td class="py-3 px-4 text-right font-mono font-bold text-amber-700 text-xs">
          ${Number(log.TienLuongCa).toLocaleString('vi-VN')} đ
        </td>
        <td class="py-3 px-4 text-slate-600 text-xs italic">
          ${log.GhiChu || '---'}
        </td>
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
            ✔ ${log.TrangThai === 'DaDuyet' ? 'Đã duyệt' : log.TrangThai}
          </span>
        </td>
        <td class="py-3 px-4 text-center">
          <button onclick="window.deleteTimekeepingEntry('${log.MaChamCong}')" class="text-rose-600 hover:text-rose-800 p-1 rounded-lg hover:bg-rose-50 transition cursor-pointer font-bold text-xs" title="Xóa bản ghi ca này">
            Xóa
          </button>
        </td>
      </tr>
    `;
  });

  if (logs.length === 0) {
    html = `<tr><td colspan="7" class="text-center py-8 text-slate-400">Chưa có nhật ký chấm ca nào.</td></tr>`;
  }
  tbody.innerHTML = html;
}

function populateStaffFormMetadata() {
  const chucVuSelect = document.getElementById('staff-form-chucvu');
  if (chucVuSelect && staffMetadata.chucVu && staffMetadata.chucVu.length > 0) {
    chucVuSelect.innerHTML = staffMetadata.chucVu.map(cv => `
      <option value="${cv.MaChucVu}">${cv.TenChucVu}</option>
    `).join('');
  }

  const boPhanSelect = document.getElementById('staff-form-bophan');
  if (boPhanSelect && staffMetadata.boPhan && staffMetadata.boPhan.length > 0) {
    boPhanSelect.innerHTML = staffMetadata.boPhan.map(bp => `
      <option value="${bp.MaBoPhan}">${bp.TenBoPhan}</option>
    `).join('');
  }

  const caSelect = document.getElementById('tk-form-ca');
  if (caSelect && staffMetadata.caLamViec && staffMetadata.caLamViec.length > 0) {
    caSelect.innerHTML = staffMetadata.caLamViec.map(ca => `
      <option value="${ca.MaCa}" data-wage="${ca.TienCongTheoCa || 200000}" data-start="${ca.GioBatDau || '06:30'}" data-end="${ca.GioKetThuc || '14:30'}" data-name="${ca.TenCa}">
        ${ca.TenCa} (${ca.GioBatDau} - ${ca.GioKetThuc}) - ${Number(ca.TienCongTheoCa || 200000).toLocaleString('vi-VN')} đ
      </option>
    `).join('');
    updateTimekeepingShiftPreview();
  }
}

function updateTimekeepingShiftPreview() {
  const caSelect = document.getElementById('tk-form-ca');
  if (!caSelect || !caSelect.selectedOptions || caSelect.selectedOptions.length === 0) return;
  const opt = caSelect.selectedOptions[0];
  const wage = opt.getAttribute('data-wage') || '200000';
  const start = opt.getAttribute('data-start') || '06:30';
  const end = opt.getAttribute('data-end') || '14:30';
  const name = opt.getAttribute('data-name') || opt.textContent;

  const wageInput = document.getElementById('tk-form-wage');
  if (wageInput) wageInput.value = wage;

  const nameEl = document.getElementById('tk-shift-name-preview');
  if (nameEl) nameEl.textContent = name;

  const hoursEl = document.getElementById('tk-shift-hours-preview');
  if (hoursEl) hoursEl.textContent = `${start} - ${end}`;

  const wageEl = document.getElementById('tk-shift-wage-preview');
  if (wageEl) wageEl.textContent = `${Number(wage).toLocaleString('vi-VN')} đ`;
}

// Modal Thêm / Chỉnh Sửa Nhân Viên (Tối giản & Tự động hóa)
function openStaffModal(maNhanVien = null) {
  const modal = document.getElementById('modal-staff-form');
  const title = document.getElementById('staff-modal-title');
  const form = document.getElementById('form-staff');
  const accountSection = document.getElementById('staff-form-account-section');
  const statusContainer = document.getElementById('staff-form-status-container');
  const idInput = document.getElementById('staff-form-id');
  const nameInput = document.getElementById('staff-form-name');
  const phoneInput = document.getElementById('staff-form-phone');
  const roleSelect = document.getElementById('staff-form-role');
  const statusSelect = document.getElementById('staff-form-status');
  const usernameInput = document.getElementById('staff-form-username');
  const passwordInput = document.getElementById('staff-form-password');

  if (maNhanVien) {
    const emp = staffEmployeesList.find(e => e.MaNhanVien === maNhanVien);
    if (!emp) return;

    title.textContent = `Chỉnh Sửa Hồ Sơ: ${emp.HoTen} (${emp.MaNhanVien})`;
    idInput.value = emp.MaNhanVien;
    nameInput.value = emp.HoTen;
    phoneInput.value = emp.SoDienThoai || '';
    if (roleSelect) roleSelect.value = emp.VaiTro || 'PhucVu';
    if (statusSelect) statusSelect.value = emp.TrangThaiLamViec || emp.TrangThaiHoatDong || 'DangLamViec';

    // Khi sửa: hiển thị ô chọn trạng thái, ẩn ô tạo tài khoản
    if (statusContainer) statusContainer.classList.remove('hidden');
    if (accountSection) accountSection.classList.add('hidden');
  } else {
    title.textContent = 'Thêm Nhân Viên & Cấp Quyền Mới';
    form.reset();
    idInput.value = '';
    delete usernameInput.dataset.manual;

    // Khi tạo mới: ẩn ô trạng thái (mặc định Đang làm việc), hiện tùy chọn tài khoản
    if (statusContainer) statusContainer.classList.add('hidden');
    if (accountSection) accountSection.classList.remove('hidden');
    if (passwordInput) passwordInput.value = '123456';
    if (statusSelect) statusSelect.value = 'DangLamViec';

    // Tự động đồng bộ số điện thoại làm Tên đăng nhập mặc định
    phoneInput.oninput = () => {
      if (!idInput.value && !usernameInput.dataset.manual) {
        usernameInput.value = phoneInput.value.trim().replace(/\s+/g, '');
      }
    };
    usernameInput.oninput = () => {
      usernameInput.dataset.manual = '1';
    };
  }

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

async function handleStaffFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('staff-form-id').value;
  const hoTen = document.getElementById('staff-form-name').value.trim();
  const soDienThoai = document.getElementById('staff-form-phone').value.trim();
  const vaiTro = document.getElementById('staff-form-role').value;
  const statusSelect = document.getElementById('staff-form-status');
  const trangThaiLamViec = statusSelect ? statusSelect.value : 'DangLamViec';

  const btn = document.getElementById('btn-submit-staff');
  btn.disabled = true;

  try {
    if (id) {
      // Cập nhật nhân viên
      const res = await fetch(`/api/employees/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hoTen, soDienThoai, viTri: vaiTro, vaiTro, trangThaiLamViec })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      showToast(`Đã cập nhật hồ sơ nhân viên ${hoTen} thành công!`, 'success');
    } else {
      // Thêm nhân viên mới (Đơn giản hóa: SĐT tự làm username nếu để trống)
      const rawUsername = document.getElementById('staff-form-username').value.trim();
      const tenDangNhap = rawUsername || soDienThoai.replace(/\s+/g, '');
      const matKhau = document.getElementById('staff-form-password').value.trim() || '123456';

      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hoTen, soDienThoai, viTri: vaiTro, vaiTro, tenDangNhap, matKhau })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      showToast(`Đã thêm thành công nhân viên mới: ${hoTen} (${data.data.maNhanVien})!`, 'success');
    }

    document.getElementById('modal-staff-form').classList.add('hidden');
    await loadStaffData();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteStaff(maNhanVien, hoTen) {
  if (!confirm(`Bạn có chắc chắn muốn xóa hoặc vô hiệu hóa nhân viên "${hoTen}" (${maNhanVien}) không?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/employees/${maNhanVien}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(`Đã xử lý xóa nhân sự ${hoTen} thành công!`, 'success');
    await loadStaffData();
  } catch (err) {
    showToast(`Lỗi xóa nhân sự: ${err.message}`, 'error');
  }
}

// Modal Chấm Ca Làm Việc (CHAM_CONG_CA)
function openTimekeepingModal(maNhanVien = null, preselectedMaCa = null) {
  const modal = document.getElementById('modal-timekeeping-form');
  const empSelect = document.getElementById('tk-form-employee');
  const caSelect = document.getElementById('tk-form-ca');
  const dateInput = document.getElementById('tk-form-date');
  const notesInput = document.getElementById('tk-form-notes');

  populateStaffFormMetadata();

  if (empSelect && staffEmployeesList.length > 0) {
    empSelect.innerHTML = staffEmployeesList.map(e => `
      <option value="${e.MaNhanVien}" ${e.MaNhanVien === maNhanVien ? 'selected' : ''}>
        ${e.HoTen} (${e.MaNhanVien} - ${e.TenChucVu || ''})
      </option>
    `).join('');
  }

  if (preselectedMaCa && caSelect) {
    caSelect.value = preselectedMaCa;
  }
  updateTimekeepingShiftPreview();

  if (dateInput) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  if (notesInput) {
    notesInput.value = '';
  }

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}


async function handleTimekeepingSubmit(e) {
  e.preventDefault();
  const maNhanVien = document.getElementById('tk-form-employee').value;
  const maCa = document.getElementById('tk-form-ca').value;
  const ngayChamCong = document.getElementById('tk-form-date').value;
  const tienLuongCa = Number(document.getElementById('tk-form-wage').value);
  const ghiChu = document.getElementById('tk-form-notes').value.trim();

  const btn = document.getElementById('btn-submit-timekeeping');
  btn.disabled = true;

  try {
    const res = await fetch('/api/payroll/timekeeping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maNhanVien, maCa, ngayChamCong, tienLuongCa, ghiChu })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(`Đã chấm ca thành công: ${tienLuongCa.toLocaleString('vi-VN')} đ!`, 'success');
    document.getElementById('modal-timekeeping-form').classList.add('hidden');
    await loadStaffData();
    await loadShiftConfigs(); // Đồng bộ số lượt đã chấm vào bảng ca làm
    await loadProfitAndLoss(); // Trực tiếp cập nhật chi phí lương ca vào P&L!
  } catch (err) {
    showToast(`Lỗi chấm ca: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteTimekeepingEntry(maChamCong) {
  if (!confirm(`Bạn có chắc muốn xóa bản ghi chấm ca "${maChamCong}" không?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/payroll/timekeeping/${maChamCong}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast('Đã xóa bản ghi chấm ca thành công!', 'success');
    await loadStaffData();
    await loadShiftConfigs();
    await loadProfitAndLoss();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

// =====================================================================================
// QUẢN LÝ THIẾT LẬP CA LÀM VIỆC (CA_LAM_VIEC) & ĐỒNG BỘ CHẤM CÔNG
// =====================================================================================
async function loadShiftConfigs() {
  try {
    const res = await fetch('/api/shifts/configs');
    const data = await res.json();
    if (data.success && data.data) {
      staffShiftsList = data.data;
      renderStaffShiftsTable(staffShiftsList);
      // Đồng bộ vào metadata để modal chấm ca luôn có danh sách mới nhất
      staffMetadata.caLamViec = staffShiftsList;
      populateStaffFormMetadata();
    }
  } catch (err) {
    console.error('Lỗi tải danh mục ca làm:', err);
  }
}

function renderStaffShiftsTable(shifts) {
  const tbody = document.getElementById('staff-shifts-tbody');
  if (!tbody) return;

  if (!shifts || shifts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-400">Chưa có ca làm việc nào được cấu hình.</td></tr>`;
    return;
  }

  tbody.innerHTML = shifts.map(s => {
    return `
      <tr class="hover:bg-slate-50/80 transition">
        <td class="py-3 px-4 font-mono font-bold text-slate-700">
          <span class="px-2.5 py-1 rounded-lg text-xs font-mono font-extrabold bg-blue-50 text-blue-800 border border-blue-200">${s.MaCa}</span>
        </td>
        <td class="py-3 px-4 font-bold text-slate-900 text-xs">
          ${s.TenCa}
        </td>
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 font-mono font-bold text-slate-800 text-xs">
            <i data-lucide="clock" class="w-3 h-3 text-slate-500"></i>
            ${s.GioBatDau} ➔ ${s.GioKetThuc}
          </span>
        </td>
        <td class="py-3 px-4 text-right font-mono font-black text-emerald-700 text-xs">
          ${Number(s.TienCongTheoCa || 0).toLocaleString('vi-VN')} đ
        </td>
        <td class="py-3 px-4 text-center">
          <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200 font-mono">
            ${s.SoCaDaCham || 0} lượt
          </span>
        </td>
        <td class="py-3 px-4 text-center">
          <div class="flex items-center justify-center gap-1.5">
            <button onclick="window.quickTimekeepForShift('${s.MaCa}')" class="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-[11px] font-bold border border-emerald-200 transition cursor-pointer" title="Chấm công ngay ca này">
              Chấm Ca
            </button>
            <button onclick="window.openShiftConfigModal('${s.MaCa}')" class="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[11px] font-bold border border-blue-200 transition cursor-pointer" title="Chỉnh sửa ca này">
              Sửa
            </button>
            <button onclick="window.deleteShiftConfig('${s.MaCa}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-bold border border-rose-200 transition cursor-pointer" title="Xóa ca này">
              Xóa
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
}


function openShiftConfigModal(maCa = null) {
  const modal = document.getElementById('modal-shift-config-form');
  const title = document.getElementById('shift-config-modal-title');
  const idInput = document.getElementById('sc-form-id');
  const nameInput = document.getElementById('sc-form-name');
  const startInput = document.getElementById('sc-form-start');
  const endInput = document.getElementById('sc-form-end');
  const wageInput = document.getElementById('sc-form-wage');

  if (maCa) {
    const shift = staffShiftsList.find(s => s.MaCa === maCa);
    if (!shift) return;
    title.textContent = `Chỉnh Sửa Ca Làm: ${shift.TenCa}`;
    idInput.value = shift.MaCa;
    idInput.disabled = true;
    idInput.classList.add('bg-slate-100', 'cursor-not-allowed');
    nameInput.value = shift.TenCa;
    startInput.value = shift.GioBatDau || '06:30';
    endInput.value = shift.GioKetThuc || '14:30';
    wageInput.value = shift.TienCongTheoCa || 200000;
  } else {
    title.textContent = 'Thiết Lập Ca Làm Việc Mới';
    idInput.value = '';
    idInput.disabled = false;
    idInput.classList.remove('bg-slate-100', 'cursor-not-allowed');
    nameInput.value = '';
    startInput.value = '17:30';
    endInput.value = '23:00';
    wageInput.value = '180000';
  }

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}


async function handleShiftConfigSubmit(e) {
  e.preventDefault();
  const idInput = document.getElementById('sc-form-id');
  const maCa = idInput.value.trim().toUpperCase();
  const tenCa = document.getElementById('sc-form-name').value.trim();
  const gioBatDau = document.getElementById('sc-form-start').value;
  const gioKetThuc = document.getElementById('sc-form-end').value;
  const tienCongTheoCa = Number(document.getElementById('sc-form-wage').value);

  const isEdit = idInput.disabled;
  const btn = document.getElementById('btn-submit-shift-config');
  btn.disabled = true;

  try {
    let res;
    if (isEdit) {
      res = await fetch(`/api/shifts/configs/${maCa}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenCa, gioBatDau, gioKetThuc, tienCongTheoCa })
      });
    } else {
      res = await fetch('/api/shifts/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maCa, tenCa, gioBatDau, gioKetThuc, tienCongTheoCa })
      });
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(data.message || 'Đã lưu thiết lập ca thành công!', 'success');
    document.getElementById('modal-shift-config-form').classList.add('hidden');
    await loadShiftConfigs();
    await loadStaffData();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteShiftConfig(maCa) {
  if (!confirm(`Bạn có chắc chắn muốn xóa ca làm việc "${maCa}" khỏi hệ thống không?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/shifts/configs/${maCa}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(data.message || 'Đã xóa ca làm việc thành công!', 'success');
    await loadShiftConfigs();
    await loadStaffData();
  } catch (err) {
    showToast(`Không thể xóa: ${err.message}`, 'error');
  }
}

function quickTimekeepForShift(maCa) {
  openTimekeepingModal(null, maCa);
}

// Gắn các hàm ra window để chạy tốt với inline onclick
window.openMenuItemEditor = openMenuItemEditor;
window.openStaffModal = openStaffModal;
window.deleteStaff = deleteStaff;
window.openTimekeepingModal = openTimekeepingModal;
window.deleteTimekeepingEntry = deleteTimekeepingEntry;
window.openShiftConfigModal = openShiftConfigModal;
window.deleteShiftConfig = deleteShiftConfig;
window.quickTimekeepForShift = quickTimekeepForShift;
window.deleteStaff = deleteStaff;
window.openTimekeepingModal = openTimekeepingModal;
window.deleteTimekeepingEntry = deleteTimekeepingEntry;

// =====================================================================================
// SỔ TAY CÔNG THỨC PHA CHẾ & ĐỊNH MỨC NGUYÊN VẬT LIỆU (BARISTA & QUẢN LÝ)
// =====================================================================================

async function loadBaristaRecipes() {
  try {
    const fetchPromises = [fetch('/api/inventory/recipes')];
    if (!inventoryMaterialsData || inventoryMaterialsData.length === 0) {
      fetchPromises.push(fetch('/api/inventory/materials'));
    }
    if (!AppState.menuItems || AppState.menuItems.length === 0) {
      fetchPromises.push(fetch('/api/menu'));
    }

    const responses = await Promise.all(fetchPromises);
    const recData = await responses[0].json();
    if (recData.success) {
      baristaRecipesList = recData.data || [];
    }

    let nextIdx = 1;
    if (!inventoryMaterialsData || inventoryMaterialsData.length === 0) {
      const matData = await responses[nextIdx++].json();
      if (matData.success) {
        inventoryMaterialsData = matData.data || [];
      }
    }
    if (!AppState.menuItems || AppState.menuItems.length === 0) {
      const menuData = await responses[nextIdx++].json();
      if (menuData.success) {
        AppState.menuItems = menuData.data.items || [];
        AppState.menuGroups = menuData.data.groups || [];
      }
    }

    renderBaristaRecipesTable();
  } catch (err) {
    console.error('Lỗi nạp công thức pha chế:', err);
  }
}

function renderBaristaRecipesTable() {
  const tbody = document.getElementById('barista-recipes-tbody');
  if (!tbody) return;

  const search = (document.getElementById('recipe-search-input')?.value || '').toLowerCase().trim();
  const allDishes = AppState.menuItems || [];

  // Gom nhóm công thức theo MaMon
  const recipeMap = new Map();
  (baristaRecipesList || []).forEach(r => {
    const mId = r.MaMon || r.maMon;
    if (!mId) return;
    if (!recipeMap.has(mId)) recipeMap.set(mId, []);
    recipeMap.get(mId).push(r);
  });

  // Lọc món theo từ khóa tìm kiếm
  const filteredDishes = allDishes.filter(m => {
    const matchName = (m.TenMon || '').toLowerCase().includes(search);
    const matchCode = (m.MaMon || '').toLowerCase().includes(search);
    const ings = recipeMap.get(m.MaMon) || [];
    const matchIng = ings.some(i => (i.TenVatTu || '').toLowerCase().includes(search));
    return matchName || matchCode || matchIng;
  });

  // Tính toán thống kê
  const configuredCount = allDishes.filter(m => recipeMap.has(m.MaMon) && recipeMap.get(m.MaMon).length > 0).length;
  const missingCount = allDishes.length - configuredCount;

  const statConfigured = document.getElementById('stat-recipes-configured');
  const statIngredients = document.getElementById('stat-recipes-ingredients');
  const statMissing = document.getElementById('stat-recipes-missing');

  if (statConfigured) statConfigured.textContent = `${configuredCount} / ${allDishes.length} Món`;
  if (statIngredients) statIngredients.textContent = `${baristaRecipesList.length} định mức`;
  if (statMissing) statMissing.textContent = `${missingCount} món`;

  const banner = document.getElementById('unconfigured-dishes-banner');
  const pills = document.getElementById('unconfigured-dishes-pills');
  if (banner && pills) {
    const unconfigured = allDishes.filter(m => !recipeMap.has(m.MaMon) || recipeMap.get(m.MaMon).length === 0);
    if (unconfigured.length > 0) {
      banner.classList.remove('hidden');
      pills.innerHTML = unconfigured.map(m => `
        <button type="button" onclick="window.openMenuItemEditor('${m.MaMon}')" class="px-3 py-1.5 bg-white hover:bg-amber-100/80 text-slate-800 border border-amber-300 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-2xs transition cursor-pointer group">
          <span class="text-amber-900 font-extrabold">☕ ${m.TenMon}</span>
          <span class="px-1.5 py-0.5 bg-amber-600 text-white rounded-md text-[10px] font-bold group-hover:bg-amber-700 transition">+ Thêm Định Mức</span>
        </button>
      `).join('');
    } else {
      banner.classList.add('hidden');
    }
  }

  if (filteredDishes.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-12 text-slate-400 space-y-2">
          <i data-lucide="coffee" class="w-8 h-8 text-slate-300 mx-auto block mb-1"></i>
          <p class="font-medium text-xs">Không tìm thấy món nào trong thực đơn.</p>
          <button type="button" onclick="window.openMenuItemEditor()" class="mt-2 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1 shadow-xs cursor-pointer">
            <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i> + Thêm Món & Công Thức Mới
          </button>
        </td>
      </tr>
    `;
    if (window.lucide) try { window.lucide.createIcons(); } catch (e) {}
    return;
  }

  let html = '';
  filteredDishes.forEach(dish => {
    const ings = recipeMap.get(dish.MaMon) || [];
    const groupName = AppState.menuGroups.find(g => g.MaNhom === dish.MaNhom)?.TenNhom || 'Đồ Uống';
    const priceStr = Number(dish.GiaBanHienHanh || 0).toLocaleString('vi-VN');
    const isSelling = dish.DangKinhDoanh !== 0;

    let ingredientsHtml = '';
    if (ings.length > 0) {
      ingredientsHtml = `
        <div class="flex flex-wrap gap-1.5 py-1">
          ${ings.map(i => `
            <span class="inline-flex items-center gap-1 px-2 py-0.8 rounded-lg bg-amber-50 text-amber-900 border border-amber-200/80 text-[11px] font-medium shadow-3xs" title="${i.GhiChu || 'Định mức ly'}">
              <span class="font-bold">${i.TenVatTu}</span>: 
              <span class="font-mono font-bold text-amber-700">${i.SoLuongDinhMuc} ${i.DonViTinh || 'g'}</span>
              ${i.GhiChu ? `<span class="text-slate-400 text-[10px] italic">(${i.GhiChu})</span>` : ''}
            </span>
          `).join('')}
        </div>
      `;
    } else {
      ingredientsHtml = `
        <span class="inline-flex items-center gap-1 text-[11px] text-slate-400 italic bg-slate-50 px-2 py-1 rounded-lg border border-slate-200/60">
          <i data-lucide="help-circle" class="w-3.5 h-3.5 text-slate-400"></i> Chưa thiết lập định mức (Chưa trừ kho)
        </span>
      `;
    }

    html += `
      <tr class="hover:bg-slate-50/80 transition group">
        <td class="py-3 px-4 align-top">
          <div class="flex items-center gap-3">
            <img src="${dish.HinhAnh || 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=100'}" alt="${dish.TenMon}" class="w-10 h-10 rounded-xl object-cover shrink-0 border border-slate-200 shadow-2xs" onerror="this.src='https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?w=100'">
            <div class="min-w-0">
              <div class="font-extrabold text-xs text-slate-900 group-hover:text-indigo-900 transition truncate">${dish.TenMon}</div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-bold">${dish.MaMon}</span>
                <span class="text-[10.5px] text-slate-400 font-medium">${groupName}</span>
              </div>
            </div>
          </div>
        </td>
        <td class="py-3 px-4 align-top">
          <div class="font-mono font-bold text-xs text-slate-900">${priceStr} đ</div>
          <div class="text-[10px] text-slate-400 font-medium">/${dish.DonViTinh || 'Ly'}</div>
        </td>
        <td class="py-3 px-4 align-top">
          ${ingredientsHtml}
        </td>
        <td class="py-3 px-4 text-center align-top">
          ${isSelling 
            ? '<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Đang Bán</span>' 
            : '<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">Ngừng Bán</span>'}
        </td>
        <td class="py-3 px-4 text-center align-top">
          <div class="flex items-center justify-center gap-1.5">
            <button type="button" onclick="window.openMenuItemEditor('${dish.MaMon}')" class="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold border border-indigo-200 transition flex items-center gap-1 cursor-pointer" title="Chỉnh sửa món & công thức">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i> <span>Sửa</span>
            </button>
            <button type="button" onclick="window.deleteMenuItem('${dish.MaMon}')" class="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer" title="Xóa món">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  if (window.lucide) try { window.lucide.createIcons(); } catch (e) {}
}

// Mở modal Thêm / Soạn thảo Công Thức Món (chuyển tiếp sang modal gộp duy nhất)
function openRecipeEditor(preselectedMaMon = null) {
  openMenuItemEditor(preselectedMaMon);
}

// Nạp các lựa chọn món vào dropdown select trong modal
function populateRecipeDishSelect(preselectedMaMon = null) {
  const dishSelect = document.getElementById('recipe-editor-mamon');
  const dishStatus = document.getElementById('recipe-editor-dish-status');
  if (!dishSelect) return;

  const items = AppState.menuItems || [];
  const groups = AppState.menuGroups || [];
  const configuredMaMons = new Set(baristaRecipesList.map(r => r.MaMon || r.maMon).filter(Boolean));

  let html = '<option value="">-- Chọn món đồ uống cần định lượng --</option>';

  if (groups.length > 0) {
    groups.forEach(g => {
      const groupItems = items.filter(i => i.MaNhom === g.MaNhom);
      if (groupItems.length > 0) {
        html += `<optgroup label="📂 ${g.TenNhom}">`;
        groupItems.forEach(i => {
          const hasRecipe = configuredMaMons.has(i.MaMon);
          const statusText = hasRecipe ? ' (Đã có công thức)' : ' ★ (Chưa có công thức)';
          const selected = (preselectedMaMon && preselectedMaMon === i.MaMon) ? 'selected' : '';
          html += `<option value="${i.MaMon}" ${selected}>${i.TenMon} - ${Number(i.GiaBanHienHanh).toLocaleString('vi-VN')}đ${statusText}</option>`;
        });
        html += `</optgroup>`;
      }
    });
  } else {
    items.forEach(i => {
      const hasRecipe = configuredMaMons.has(i.MaMon);
      const statusText = hasRecipe ? ' (Đã có công thức)' : ' ★ (Chưa có công thức)';
      const selected = (preselectedMaMon && preselectedMaMon === i.MaMon) ? 'selected' : '';
      html += `<option value="${i.MaMon}" ${selected}>${i.TenMon}${statusText}</option>`;
    });
  }

  dishSelect.innerHTML = html;

  // Cập nhật trạng thái hiển thị
  function updateDishStatus() {
    const val = dishSelect.value;
    if (!val) {
      if (dishStatus) dishStatus.textContent = '';
      return;
    }
    const hasRecipe = configuredMaMons.has(val);
    const existingCount = baristaRecipesList.filter(r => (r.MaMon || r.maMon) === val).length;
    if (dishStatus) {
      dishStatus.textContent = hasRecipe 
        ? `Món này hiện đang có ${existingCount} nguyên liệu định mức. Bạn có thể thêm nguyên liệu mới hoặc cập nhật.`
        : `Món này chưa có công thức định lượng. Hãy thêm nguyên liệu chuẩn bên dưới.`;
    }
  }

  dishSelect.onchange = updateDishStatus;
  updateDishStatus();
}

// Mở modal sửa 1 mục công thức cụ thể
function openEditRecipeItem(maCongThuc) {
  const modal = document.getElementById('modal-recipe-editor');
  if (!modal) return;

  const item = baristaRecipesList.find(r => (r.MaCongThuc || r.maCongThuc) === maCongThuc);
  if (!item) {
    showToast('Không tìm thấy thông tin công thức!', 'error');
    return;
  }

  const title = document.getElementById('recipe-editor-title');
  const editIdInput = document.getElementById('recipe-editor-edit-id');
  const dishSelect = document.getElementById('recipe-editor-mamon');
  const dishStatus = document.getElementById('recipe-editor-dish-status');
  const rowsContainer = document.getElementById('recipe-ingredients-rows');
  const btnAddRow = document.getElementById('btn-add-recipe-ingredient-row');

  if (title) title.textContent = `Chỉnh Sửa Định Mức: ${item.TenMon || item.tenMon}`;
  if (editIdInput) editIdInput.value = item.MaCongThuc || item.maCongThuc;

  populateRecipeDishSelect(item.MaMon || item.maMon);
  if (dishSelect) dishSelect.disabled = true;
  if (dishStatus) dishStatus.textContent = `Đang chỉnh sửa nguyên liệu thành phần cho món ${item.TenMon || item.tenMon}.`;
  if (btnAddRow) btnAddRow.classList.add('hidden');

  if (rowsContainer) {
    rowsContainer.innerHTML = '';
    addRecipeIngredientRow({
      maVatTu: item.MaVatTu || item.maVatTu,
      soLuongDinhMuc: item.SoLuongDinhMuc ?? item.dinhMuc,
      donViTinh: item.DonViTinh || item.donViTinh,
      ghiChu: item.GhiChu || item.ghiChuKyThuat
    }, false);
  }

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

// Thêm dòng nguyên liệu vào form
function addRecipeIngredientRow(initialData = {}, canDelete = true) {
  const container = document.getElementById('recipe-ingredients-rows');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'recipe-ingredient-row bg-slate-50 border border-slate-200/80 rounded-2xl p-3 space-y-2.5 transition';

  const materials = inventoryMaterialsData || [];
  let matOptions = '<option value="">-- Chọn nguyên vật liệu --</option>';
  materials.forEach(m => {
    const selected = (initialData.maVatTu && initialData.maVatTu === m.MaVatTu) ? 'selected' : '';
    matOptions += `
      <option value="${m.MaVatTu}" data-dvt="${m.DonViTinh}" ${selected}>
        ${m.TenVatTu} (${m.DonViTinh}) - Tồn: ${Number(m.SoLuongTonHienTai).toLocaleString('vi-VN')} ${m.DonViTinh}
      </option>
    `;
  });

  row.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div class="flex-1">
        <label class="block font-bold text-slate-700 mb-1">Nguyên Vật Liệu: <span class="text-rose-500">*</span></label>
        <select class="recipe-row-mat w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:border-amber-500" required>
          ${matOptions}
        </select>
      </div>
      ${canDelete ? `
        <button type="button" class="btn-remove-recipe-row text-slate-400 hover:text-rose-600 p-1 rounded-lg hover:bg-slate-200/60 transition mt-4 cursor-pointer" title="Xóa dòng nguyên liệu này">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      ` : ''}
    </div>

    <div class="grid grid-cols-3 gap-2">
      <div class="col-span-2">
        <label class="block font-bold text-slate-700 mb-1">Định Mức / Ly: <span class="text-rose-500">*</span></label>
        <div class="flex items-center gap-1.5">
          <input type="number" step="any" min="0.001" class="recipe-row-qty flex-1 bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-mono font-bold text-slate-800 focus:outline-none focus:border-amber-500" placeholder="VD: 25" required value="${initialData.soLuongDinhMuc ?? ''}">
          <input type="text" class="recipe-row-unit w-16 bg-slate-100 border border-slate-300 rounded-xl px-1.5 py-1.5 text-xs font-mono font-bold text-slate-700 text-center" placeholder="ĐVT" readonly value="${initialData.donViTinh || ''}">
        </div>
      </div>
      <div>
        <label class="block font-bold text-slate-700 mb-1">Quy Chuẩn:</label>
        <span class="recipe-row-dvt-hint text-[11px] text-amber-800 font-semibold block pt-1.5">Chuẩn ly</span>
      </div>
    </div>

    <div>
      <label class="block font-medium text-slate-600 mb-1">Quy Trình & Kỹ Thuật Pha Chế (Barista Note):</label>
      <input type="text" class="recipe-row-note w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-amber-500" placeholder="VD: Chiết xuất 45ml cốt trong 25s, khuấy tan nước đường..." value="${initialData.ghiChu || ''}">
    </div>
  `;

  // Tự động gán ĐVT khi chọn nguyên liệu
  const matSelect = row.querySelector('.recipe-row-mat');
  const unitInput = row.querySelector('.recipe-row-unit');
  const removeBtn = row.querySelector('.btn-remove-recipe-row');

  matSelect.addEventListener('change', () => {
    const opt = matSelect.options[matSelect.selectedIndex];
    const dvt = opt ? opt.getAttribute('data-dvt') : '';
    if (unitInput) unitInput.value = dvt || 'g';
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const allRows = container.querySelectorAll('.recipe-ingredient-row');
      if (allRows.length <= 1) {
        showToast('Công thức phải có ít nhất một nguyên liệu!', 'warning');
        return;
      }
      row.remove();
    });
  }

  // Khởi tạo đơn vị tính ban đầu nếu có
  if (!initialData.donViTinh && matSelect.value) {
    const opt = matSelect.options[matSelect.selectedIndex];
    if (opt && unitInput) unitInput.value = opt.getAttribute('data-dvt') || 'g';
  }

  container.appendChild(row);
  if (window.lucide) window.lucide.createIcons();
}

// Đóng modal công thức
function closeRecipeEditor() {
  const modal = document.getElementById('modal-recipe-editor');
  if (modal) modal.classList.add('hidden');
}

// Xử lý gửi Form Lưu Công Thức Món
async function handleRecipeEditorSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('recipe-editor-edit-id')?.value;
  const dishSelect = document.getElementById('recipe-editor-mamon');
  const maMon = dishSelect?.value;

  if (!maMon) {
    showToast('Vui lòng chọn món đồ uống cần lập công thức!', 'warning');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-recipe-editor');
  if (submitBtn) submitBtn.disabled = true;

  try {
    if (editId) {
      // Cập nhật 1 nguyên liệu cụ thể
      const row = document.querySelector('.recipe-ingredient-row');
      const maVatTu = row?.querySelector('.recipe-row-mat')?.value;
      const soLuongDinhMuc = parseFloat(row?.querySelector('.recipe-row-qty')?.value);
      const donViTinh = row?.querySelector('.recipe-row-unit')?.value;
      const ghiChu = row?.querySelector('.recipe-row-note')?.value || '';

      if (!maVatTu || isNaN(soLuongDinhMuc) || soLuongDinhMuc <= 0) {
        showToast('Vui lòng nhập định mức nguyên liệu hợp lệ!', 'warning');
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const res = await fetch(`/api/inventory/recipes/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maVatTu, soLuongDinhMuc, donViTinh, ghiChu })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      showToast(data.message || 'Cập nhật công thức thành công!', 'success');
    } else {
      // Thêm mới (hỗ trợ nhiều dòng nguyên vật liệu cùng lúc)
      const rows = document.querySelectorAll('.recipe-ingredient-row');
      const ingredients = [];

      rows.forEach(r => {
        const maVatTu = r.querySelector('.recipe-row-mat')?.value;
        const soLuongDinhMuc = parseFloat(r.querySelector('.recipe-row-qty')?.value);
        const donViTinh = r.querySelector('.recipe-row-unit')?.value;
        const ghiChu = r.querySelector('.recipe-row-note')?.value || '';

        if (maVatTu && !isNaN(soLuongDinhMuc) && soLuongDinhMuc > 0) {
          ingredients.push({ maVatTu, soLuongDinhMuc, donViTinh, ghiChu });
        }
      });

      if (ingredients.length === 0) {
        showToast('Vui lòng điền ít nhất một nguyên liệu và định mức hợp lệ!', 'warning');
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const res = await fetch('/api/inventory/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maMon, ingredients })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      showToast(data.message || 'Đã lưu công thức món thành công!', 'success');
    }

    if (window.playNotificationChime) window.playNotificationChime();
    closeRecipeEditor();
    await loadBaristaRecipes();
  } catch (err) {
    console.error('Lỗi lưu công thức món:', err);
    showToast(err.message || 'Lỗi khi lưu công thức món', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Xóa 1 nguyên liệu khỏi công thức món
async function deleteRecipeItem(maCongThuc, tenMon, tenVatTu) {
  if (!confirm(`Bạn có chắc chắn muốn xóa nguyên liệu "${tenVatTu}" khỏi công thức của "${tenMon}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/inventory/recipes/${maCongThuc}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    showToast(data.message || 'Đã xóa nguyên liệu khỏi công thức!', 'success');
    await loadBaristaRecipes();
  } catch (err) {
    console.error('Lỗi xóa công thức:', err);
    showToast(err.message || 'Lỗi khi xóa công thức', 'error');
  }
}

window.openRecipeEditor = openRecipeEditor;
window.openEditRecipeItem = openEditRecipeItem;
window.deleteRecipeItem = deleteRecipeItem;
window.closeRecipeEditor = closeRecipeEditor;

// sidebarLogoRotation defined at top

// Biến chống duplicate event / debounce khi người dùng nhấn nhanh
let lastSidebarToggleTime = 0;

function toggleSidebar(e) {
  if (e) {
    if (e.stopPropagation) e.stopPropagation();
  }
  const now = Date.now();
  if (now - lastSidebarToggleTime < 480) {
    return; // Chống double-click hoặc trigger trùng lặp sự kiện trong lúc đang trượt mượt
  }
  lastSidebarToggleTime = now;

  AppState.isSidebarCollapsed = !AppState.isSidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const brandBox = document.getElementById('sidebar-brand-box');
  const logoIcon = document.getElementById('sidebar-logo-icon');

  // Kích hoạt hiệu ứng xoay logo siêu mượt bằng CSS Keyframes (100% xoay mượt mà, không bao giờ bị đơ)
  if (logoIcon) {
    logoIcon.classList.remove('logo-spin-forward', 'logo-spin-backward');
    void logoIcon.offsetWidth; // buộc trình duyệt reflow để kích hoạt lại keyframe animation
    if (AppState.isSidebarCollapsed) {
      logoIcon.classList.add('logo-spin-backward');
    } else {
      logoIcon.classList.add('logo-spin-forward');
    }
  }

  // Điều khiển thanh công cụ thụt vào / thụt ra mượt mà theo chuẩn CSS
  if (AppState.isSidebarCollapsed) {
    // 1. THỤT VÀO: Thu hẹp thanh công cụ về 80px (5rem)
    sidebar?.classList.add('sidebar-collapsed');
    sidebar?.classList.remove('w-64');
    sidebar?.classList.add('w-20');
    if (sidebar) {
      sidebar.style.width = '5rem';
      sidebar.style.minWidth = '5rem';
      sidebar.style.maxWidth = '5rem';
    }
    brandBox?.classList.remove('space-x-2.5');
    brandBox?.classList.add('justify-center');
    brandBox?.setAttribute('title', 'Nhấn vào Logo để Mở rộng thanh công cụ');
  } else {
    // 2. THỤT RA: Mở rộng thanh công cụ trở lại 256px (16rem)
    sidebar?.classList.remove('sidebar-collapsed');
    sidebar?.classList.remove('w-20');
    sidebar?.classList.add('w-64');
    if (sidebar) {
      sidebar.style.width = '16rem';
      sidebar.style.minWidth = '16rem';
      sidebar.style.maxWidth = '16rem';
    }
    brandBox?.classList.remove('justify-center');
    brandBox?.classList.add('space-x-2.5');
    brandBox?.setAttribute('title', 'Nhấn vào Logo để Thu gọn thanh công cụ');
  }
}

window.toggleSidebar = toggleSidebar;

// =====================================================================================
// EVENT HANDLERS
// =====================================================================================
function initEventHandlers() {
  // Sidebar Toggle: Nút logo đã có onclick="window.toggleSidebar(event)" trực tiếp trên HTML,
  // không bind thêm addEventListener để tránh bị kích hoạt 2 lần liên tiếp (double toggle).
  document.getElementById('sidebar-role-collapsed-box')?.addEventListener('click', toggleSidebar);

  // Main Navigation Tabs (URL Routing & Direct In-App Navigation)
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Cho phép mở tab mới khi nhấn Ctrl / Command / Middle click
      if (e.ctrlKey || e.metaKey || e.button === 1) return;
      e.preventDefault();
      const tab = btn.getAttribute('data-tab');
      if (tab) navigateToTab(tab, true);
    });
  });

  // Role selector (Đồng bộ cả Sidebar lẫn Top Header)
  document.getElementById('select-role')?.addEventListener('change', (e) => {
    applyRolePermissions(e.target.value);
    showToast(`Đã chuyển đổi sang vai trò: ${e.target.value}`);
  });
  document.getElementById('header-select-role')?.addEventListener('change', (e) => {
    applyRolePermissions(e.target.value);
    showToast(`Đã chuyển đổi sang vai trò: ${e.target.value}`);
  });

  // Mobile Drawer Toggle (Mở/đóng thanh công cụ trên Điện thoại & Tablet)
  document.getElementById('btn-mobile-sidebar-toggle')?.addEventListener('click', () => {
    toggleMobileSidebar();
  });
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
    toggleMobileSidebar(true);
  });

  // Mở đơn mang đi mới
  document.getElementById('btn-add-takeaway-tab')?.addEventListener('click', openTakeawayTab);

  // Đóng bàn và chuyển về trạng thái Bàn Trống
  document.getElementById('btn-release-table')?.addEventListener('click', releaseCurrentTable);

  // Về sơ đồ quán (Ẩn tab bàn hiện tại)
  document.getElementById('btn-close-current-tab')?.addEventListener('click', () => {
    switchPosTab('floor');
  });

  // Menu Search
  document.getElementById('menu-search-input')?.addEventListener('input', () => {
    renderMenuItems();
  });

  // Xóa giỏ hàng của bàn này
  document.getElementById('btn-clear-tab-cart')?.addEventListener('click', () => {
    const currentTab = getCurrentTab();
    if (currentTab) {
      currentTab.cart = [];
      renderTabCart();
      renderPosTableTabs();
    }
  });

  // Tra cứu thành viên VIP
  document.getElementById('btn-search-customer')?.addEventListener('click', async () => {
    const phone = document.getElementById('cust-phone-input')?.value;
    if (!phone) return;

    try {
      const res = await fetch(`/api/customers/search?phone=${encodeURIComponent(phone)}`);
      const data = await res.json();
      if (data.success && data.data) {
        const currentTab = getCurrentTab();
        if (currentTab) currentTab.customer = data.data;

        document.getElementById('customer-info-tag')?.classList.remove('hidden');
        document.getElementById('cust-name-display').textContent = data.data.HoTen;
        document.getElementById('cust-tier-display').textContent = `${data.data.HangThanhVien} (-${data.data.chietKhauPhanTram}%)`;
        document.getElementById('cust-points-display').textContent = `${data.data.DiemTichLuy} điểm`;
        updateTabCartTotals();
        showToast(`Tìm thấy khách hàng VIP: ${data.data.HoTen}`);
      } else {
        showToast('Không tìm thấy thông tin khách hàng', 'warning');
      }
    } catch (e) {
      console.error(e);
    }
  });

  // Gửi bếp KDS (Chống Race Condition / Double Submit & Chỉ gửi món mới / gọi thêm)
  document.getElementById('btn-send-kds')?.addEventListener('click', async () => {
    if (isSubmittingKDS) return;

    const currentTab = getCurrentTab();
    if (!currentTab || !currentTab.cart || currentTab.cart.length === 0) {
      showToast('Bàn này chưa chọn món nào để gửi bếp!', 'warning');
      return;
    }

    // 1. Chỉ lọc ra các món có newQty = quantity - (sent_quantity || 0) > 0
    const itemsToSend = [];
    currentTab.cart.forEach(item => {
      const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.soLuong || 0);
      const sentQty = Number(item.sent_quantity || 0);
      const newQty = qty - sentQty;
      if (newQty > 0) {
        itemsToSend.push({
          maMon: item.maMon,
          soLuong: newQty,
          quantity: newQty, // ĐÓNG GÓI DUY NHẤT SỐ LƯỢNG MỚI THÊM
          donGia: item.donGia,
          ghiChuTopping: item.ghiChuTopping || ''
        });
      }
    });

    if (itemsToSend.length === 0) {
      showToast('Tất cả món đã được gửi bếp trước đó, không có món mới cần gửi!', 'info');
      return;
    }

    // 2. Frontend POS: Khóa nút "Gửi Bếp" ngay lập tức, đổi text và hiển thị spinner
    isSubmittingKDS = true;
    const sendBtn = document.getElementById('btn-send-kds');
    const originalBtnHtml = sendBtn ? sendBtn.innerHTML : '';
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.classList.add('opacity-60', 'cursor-not-allowed');
      sendBtn.innerHTML = `
        <span class="inline-flex items-center gap-1.5">
          <svg class="animate-spin h-3.5 w-3.5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>Đang gửi bếp...</span>
        </span>
      `;
    }

    try {
      const isAddOn = Boolean(currentTab.activeOrderId);
      const orderDto = {
        soHoaDon: currentTab.activeOrderId || undefined,
        kenhDatHang: currentTab.type === 'takeaway' ? 'MangDi' : 'TaiBan',
        maBan: currentTab.type === 'takeaway' ? null : currentTab.tableId,
        maNhanVien: AppState.currentUser?.maNhanVien || 'NV03',
        maKhachHang: currentTab.customer?.MaKhachHang || null,
        items: itemsToSend,
        phuongThucThanhToan: 'TienMat',
        thanhToanNgay: false,
        isAddOn: isAddOn
      };

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderDto)
      });
      const data = await res.json();
      if (data.success) {
        currentTab.activeOrderId = data.data.soHoaDon;
        currentTab.currentOrderCode = data.data.soHoaDon;
        currentTab.status = 'CoKhach';

        // Cập nhật trạng thái các món vừa gửi trên POS thành 'SENT_TO_KDS' và sent_quantity = quantity
        currentTab.cart.forEach(item => {
          const totalQty = item.quantity !== undefined ? item.quantity : item.soLuong;
          item.quantity = totalQty;
          item.soLuong = totalQty;
          item.sent_quantity = totalQty;
          item.kds_status = 'SENT_TO_KDS';
        });

        if (data.isAddOn || isAddOn) {
          showToast(`🛎️ Đã gửi THÊM món thành công cho ${currentTab.tableName} (Đợt ${data.lanGoi || 2})!`, 'success');
        } else {
          showToast(`Đã gửi bếp thành công order của ${currentTab.tableName}!`, 'success');
        }

        loadTables();
        loadKdsTickets();
        renderTabCart();
        renderCurrentTabDetail();
        renderPosTableTabs();
        saveTabsToStorage();
      } else {
        showToast(`Gửi bếp thất bại: ${data.message || 'Lỗi không xác định'}`, 'error');
      }
    } catch (e) {
      console.error(e);
      showToast(`Lỗi khi gửi bếp: ${e.message}`, 'error');
    } finally {
      isSubmittingKDS = false;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.classList.remove('opacity-60', 'cursor-not-allowed');
        sendBtn.innerHTML = originalBtnHtml;
      }
    }
  });

  // Nút mở modal Báo Tạm Hết Món (86'd Items) trên KDS
  document.getElementById('btn-kds-86-modal')?.addEventListener('click', openKds86Modal);
  document.getElementById('btn-close-kds-86-modal')?.addEventListener('click', closeKds86Modal);
  document.getElementById('btn-done-kds-86-modal')?.addEventListener('click', closeKds86Modal);
  document.getElementById('kds-86-search-input')?.addEventListener('input', () => renderKds86List());
  document.querySelectorAll('.kds-86-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.kds-86-filter-btn').forEach(b => {
        b.classList.remove('bg-white', 'text-slate-800', 'shadow-xs');
        b.classList.add('text-slate-600');
      });
      btn.classList.add('bg-white', 'text-slate-800', 'shadow-xs');
      btn.classList.remove('text-slate-600');
      kds86ActiveFilter = btn.getAttribute('data-filter') || 'all';
      renderKds86List();
    });
  });

  // In tạm tính & Chuyển bàn & Ghép bàn
  document.getElementById('btn-quick-print-bill')?.addEventListener('click', quickPrintBill);
  document.getElementById('btn-transfer-table-modal')?.addEventListener('click', openTransferTableModal);
  document.getElementById('btn-close-transfer')?.addEventListener('click', () => {
    document.getElementById('modal-transfer-table').classList.add('hidden');
  });
  document.getElementById('btn-confirm-transfer')?.addEventListener('click', confirmTableTransfer);

  // Ghép bàn (Merge Tables)
  document.getElementById('btn-merge-table-modal')?.addEventListener('click', openMergeTableModal);
  document.getElementById('btn-close-merge')?.addEventListener('click', () => {
    document.getElementById('modal-merge-table')?.classList.add('hidden');
  });
  document.getElementById('btn-confirm-merge')?.addEventListener('click', confirmTableMerge);

  // Chế độ tập trung (Focus Mode)
  document.getElementById('btn-toggle-focus-mode')?.addEventListener('click', () => toggleFocusMode());
  document.getElementById('btn-exit-focus-mode')?.addEventListener('click', () => toggleFocusMode(false));

  // Thêm món ngoài menu (Custom Ad-hoc Item kèm upload ảnh & chọn ảnh mẫu)
  document.getElementById('btn-open-custom-item')?.addEventListener('click', openCustomItemModal);
  document.getElementById('btn-close-custom-item')?.addEventListener('click', () => {
    document.getElementById('modal-custom-menu-item')?.classList.add('hidden');
  });
  document.getElementById('form-custom-menu-item')?.addEventListener('submit', submitCustomItem);

  document.getElementById('btn-upload-custom-item-img')?.addEventListener('click', () => {
    document.getElementById('custom-item-file-input')?.click();
  });
  document.getElementById('custom-item-file-input')?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleImageFileUpload(e.target.files[0], setCustomItemImage);
    }
  });
  document.getElementById('custom-item-image-url')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) setCustomItemImage(val);
    else resetCustomItemImage();
  });
  document.getElementById('btn-remove-custom-item-img')?.addEventListener('click', resetCustomItemImage);
  document.querySelectorAll('#custom-item-preset-chips .preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const url = chip.getAttribute('data-url');
      if (url) setCustomItemImage(url);
    });
  });

  // Mở & Đóng Phiếu Gọi Món (Popup modal giữa màn hình)
  document.getElementById('btn-open-pos-cart')?.addEventListener('click', openPosCartModal);
  document.getElementById('btn-floating-pos-cart')?.addEventListener('click', openPosCartModal);
  document.getElementById('btn-close-pos-cart')?.addEventListener('click', closePosCartModal);
  document.getElementById('btn-continue-ordering')?.addEventListener('click', closePosCartModal);
  document.getElementById('modal-pos-cart')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-pos-cart') closePosCartModal();
  });

  // Quản lý & Thêm món mới kèm công thức vào thực đơn chính (DANH_MUC_MON & CONG_THUC_MON)
  document.getElementById('btn-open-add-menu-item')?.addEventListener('click', () => openMenuItemEditor());
  document.getElementById('btn-recipes-add-dish')?.addEventListener('click', () => openMenuItemEditor());
  document.getElementById('btn-menu-editor-add-ingredient')?.addEventListener('click', () => addMenuEditorIngredientRow());
  document.getElementById('btn-close-menu-editor')?.addEventListener('click', () => {
    document.getElementById('modal-menu-item-editor')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-menu-editor')?.addEventListener('click', () => {
    document.getElementById('modal-menu-item-editor')?.classList.add('hidden');
  });
  document.getElementById('modal-menu-item-editor')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-menu-item-editor') {
      document.getElementById('modal-menu-item-editor')?.classList.add('hidden');
    }
  });
  document.getElementById('form-menu-item-editor')?.addEventListener('submit', handleMenuItemSubmit);

  document.getElementById('btn-upload-menu-editor-img')?.addEventListener('click', () => {
    document.getElementById('menu-editor-file-input')?.click();
  });
  document.getElementById('menu-editor-file-input')?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleImageFileUpload(e.target.files[0], setMenuItemImage);
    }
  });
  document.getElementById('menu-editor-image-url')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) setMenuItemImage(val);
    else resetMenuItemImage();
  });
  document.getElementById('btn-remove-menu-editor-img')?.addEventListener('click', resetMenuItemImage);
  document.querySelectorAll('#menu-editor-preset-grid .menu-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-url');
      if (url) setMenuItemImage(url);
    });
  });

  // Xem lịch sử hủy / thay đổi món
  document.getElementById('btn-view-cancel-history')?.addEventListener('click', openCancelHistoryModal);
  document.getElementById('btn-close-cancel-history')?.addEventListener('click', () => {
    document.getElementById('modal-cancel-history')?.classList.add('hidden');
  });

  // Lịch phân ca (Schedule)
  document.getElementById('btn-open-assign-schedule')?.addEventListener('click', () => openAssignScheduleModal());
  document.getElementById('btn-close-assign-schedule')?.addEventListener('click', () => {
    document.getElementById('modal-assign-schedule')?.classList.add('hidden');
  });
  document.getElementById('form-assign-schedule')?.addEventListener('submit', submitAssignSchedule);
  document.getElementById('btn-refresh-schedule')?.addEventListener('click', loadScheduleData);
  document.getElementById('btn-schedule-prev-week')?.addEventListener('click', () => {
    scheduleWeekOffset--;
    loadScheduleData();
  });
  document.getElementById('btn-schedule-next-week')?.addEventListener('click', () => {
    scheduleWeekOffset++;
    loadScheduleData();
  });
  document.getElementById('btn-schedule-this-week')?.addEventListener('click', () => {
    scheduleWeekOffset = 0;
    loadScheduleData();
  });

  // KDS View Modes: Theo đơn vs Pha gộp nhiều ly
  document.getElementById('btn-kds-mode-orders')?.addEventListener('click', () => switchKdsViewMode('orders'));
  document.getElementById('btn-kds-mode-batch')?.addEventListener('click', () => switchKdsViewMode('batch'));

  // Đăng ký tài khoản (Register Modal)
  document.getElementById('btn-open-register')?.addEventListener('click', openRegisterModal);
  document.getElementById('btn-back-to-login')?.addEventListener('click', () => {
    closeRegisterModal();
    openLoginModal();
  });
  document.getElementById('btn-close-register')?.addEventListener('click', closeRegisterModal);
  document.getElementById('form-register')?.addEventListener('submit', handleRegisterSubmit);

  // Mở modal thanh toán
  document.getElementById('btn-open-payment')?.addEventListener('click', openCheckoutModalForCurrentTab);
  document.getElementById('btn-close-checkout')?.addEventListener('click', () => {
    document.getElementById('modal-checkout').classList.add('hidden');
  });

  // Chọn phương thức thanh toán (Bao gồm VietQR, MoMo, VNPay theo Hình 1 RBAC)
  document.querySelectorAll('.pay-method-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pay-method-btn').forEach(b => {
        b.className = 'pay-method-btn py-2 px-1.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 text-xs font-bold flex flex-col items-center gap-1';
      });
      btn.className = 'pay-method-btn py-2 px-1.5 rounded-xl border-2 border-amber-600 bg-amber-50 text-amber-900 text-xs font-extrabold flex flex-col items-center gap-1 shadow-xs';

      selectedPayMethod = btn.getAttribute('data-method');
      const currentTab = getCurrentTab();
      let subtotal = 0;
      currentTab?.cart.forEach(i => subtotal += i.donGia * i.soLuong);
      let memberDiscount = 0;
      if (currentTab?.customer?.chietKhauPhanTram) {
        memberDiscount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
      }
      let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
      const total = Math.max(0, subtotal - memberDiscount - voucherDiscount);

      updatePaymentGatewayQr(total);
    });
  });

  // Áp dụng Voucher (<<extend>> Thanh toán đơn hàng)
  document.getElementById('btn-apply-voucher')?.addEventListener('click', () => {
    const code = document.getElementById('input-voucher-code')?.value;
    applyVoucherCode(code);
  });
  document.querySelectorAll('.quick-voucher').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      applyVoucherCode(code);
    });
  });

  // Phê duyệt Hủy món (RBAC Audit: Chủ Quán / Quản Lý / Thu Ngân)
  document.getElementById('btn-confirm-cancel-by-manager')?.addEventListener('click', confirmCancelWithApproval);
  document.getElementById('btn-close-cancel-approval')?.addEventListener('click', () => {
    document.getElementById('modal-cancel-approval')?.classList.add('hidden');
  });
  document.getElementById('btn-dismiss-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-cancel-approval')?.classList.add('hidden');
  });

  // Tải lại Nhân sự & Sổ tay công thức
  document.getElementById('btn-refresh-staff')?.addEventListener('click', loadStaffData);
  document.getElementById('btn-refresh-recipes')?.addEventListener('click', loadBaristaRecipes);
  document.getElementById('recipe-search-input')?.addEventListener('input', renderBaristaRecipesTable);
  document.getElementById('btn-open-add-recipe')?.addEventListener('click', () => openRecipeEditor());
  document.getElementById('btn-close-recipe-editor')?.addEventListener('click', closeRecipeEditor);
  document.getElementById('btn-cancel-recipe-editor')?.addEventListener('click', closeRecipeEditor);
  document.getElementById('btn-add-recipe-ingredient-row')?.addEventListener('click', () => addRecipeIngredientRow());
  document.getElementById('form-recipe-editor')?.addEventListener('submit', handleRecipeEditorSubmit);
  document.getElementById('btn-toggle-unconfigured')?.addEventListener('click', () => {
    const banner = document.getElementById('unconfigured-dishes-banner');
    if (banner) banner.classList.toggle('hidden');
  });

  // Các nút chọn tiền mặt nhanh
  document.querySelectorAll('.quick-cash').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      const input = document.getElementById('input-cash-given');
      const currentTab = getCurrentTab();
      if (val === 'exact') {
        let subtotal = 0;
        currentTab?.cart.forEach(i => subtotal += i.donGia * i.soLuong);
        let memberDiscount = 0;
        if (currentTab?.customer?.chietKhauPhanTram) {
          memberDiscount = (subtotal * currentTab.customer.chietKhauPhanTram) / 100;
        }
        let voucherDiscount = currentVoucher ? currentVoucher.discount : 0;
        input.value = Math.max(0, subtotal - memberDiscount - voucherDiscount);
      } else {
        input.value = val;
      }
      calculateChange();
    });
  });

  document.getElementById('input-cash-given')?.addEventListener('input', calculateChange);
  document.getElementById('btn-submit-payment')?.addEventListener('click', submitCurrentTabPayment);

  // Tra cứu công thức (Chuyển nhanh sang tab recipes)
  document.getElementById('btn-recipe-lookup')?.addEventListener('click', () => {
    switchMainTab('recipes');
  });
  document.getElementById('btn-close-recipes')?.addEventListener('click', () => {
    document.getElementById('modal-recipes').classList.add('hidden');
  });

  // Chế độ mô phỏng Offline
  document.getElementById('btn-toggle-offline')?.addEventListener('click', async () => {
    AppState.isSimulatedOffline = !AppState.isSimulatedOffline;
    updateNetworkBadge(!AppState.isSimulatedOffline);

    if (!AppState.isSimulatedOffline) {
      const offlineOrders = await window.OfflineDB.getOfflineOrders();
      if (offlineOrders.length > 0) {
        showToast(`Đang đồng bộ ${offlineOrders.length} đơn hàng ngoại tuyến lên Server...`);
        const res = await fetch('/api/orders/reconciliation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: offlineOrders })
        });
        const recData = await res.json();
        if (recData.success) {
          await window.OfflineDB.clearOfflineOrders();
          showToast(recData.message, 'success');
          loadTables();
          loadShiftData();
        }
      }
    }
  });

  // Mô phỏng in ấn & Ngăn kéo
  document.getElementById('btn-test-drawer-kick')?.addEventListener('click', triggerDrawerKickPulse);
  document.getElementById('btn-physical-print')?.addEventListener('click', () => printReceipt());

  // Chốt ca & Bàn giao két tiền mặt
  document.getElementById('btn-shift-drawer-kick')?.addEventListener('click', triggerDrawerKickPulse);
  document.getElementById('btn-refresh-shift')?.addEventListener('click', () => loadShiftData());
  document.getElementById('btn-open-new-shift-trigger')?.addEventListener('click', () => {
    if (AppState.currentShift) {
      showToast('Đang có một ca làm việc đang mở. Vui lòng đối soát và chốt ca này trước khi mở ca mới!', 'info');
      document.getElementById('input-actual-cash')?.focus();
    } else {
      const closedCard = document.getElementById('shift-closed-card');
      if (closedCard) {
        closedCard.classList.remove('hidden');
        closedCard.scrollIntoView({ behavior: 'smooth' });
        document.getElementById('open-shift-ca')?.focus();
      }
    }
  });
  document.getElementById('form-open-new-shift')?.addEventListener('submit', handleOpenShiftSubmit);
  document.getElementById('input-actual-cash')?.addEventListener('input', calculateShiftDifference);
  document.getElementById('btn-close-shift')?.addEventListener('click', closeCurrentShift);
  document.getElementById('btn-shift-modal')?.addEventListener('click', () => switchMainTab('shift'));

  // Refresh dữ liệu
  document.getElementById('btn-refresh-pnl')?.addEventListener('click', loadProfitAndLoss);
  document.getElementById('btn-refresh-inventory')?.addEventListener('click', loadInventoryView);

  // =====================================================================================
  // EVENT LISTENERS: TỒN KHO NGUYÊN VẬT LIỆU (TÌM KIẾM, LỌC & MODALS)
  // =====================================================================================
  // Tìm kiếm tức thì nguyên vật liệu
  const searchInvInput = document.getElementById('inventory-search-input');
  const clearInvSearchBtn = document.getElementById('btn-inventory-search-clear');
  searchInvInput?.addEventListener('input', (e) => {
    inventorySearchQuery = e.target.value;
    if (clearInvSearchBtn) {
      clearInvSearchBtn.classList.toggle('hidden', !inventorySearchQuery.trim());
    }
    applyInventoryFilterAndRender();
  });

  clearInvSearchBtn?.addEventListener('click', () => {
    if (searchInvInput) searchInvInput.value = '';
    inventorySearchQuery = '';
    clearInvSearchBtn.classList.add('hidden');
    applyInventoryFilterAndRender();
  });

  // Bộ lọc trạng thái (Tất cả, Cần nhập, Sắp hết, Đủ tồn)
  document.querySelectorAll('.inv-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter') || 'all';
      filterInventory(filter);
    });
  });

  // Modal Nhập Kho
  document.getElementById('btn-open-stockin-modal')?.addEventListener('click', () => openStockInModal());
  document.getElementById('btn-close-stockin')?.addEventListener('click', closeStockInModal);
  document.getElementById('btn-cancel-stockin')?.addEventListener('click', closeStockInModal);
  document.getElementById('form-stockin')?.addEventListener('submit', handleStockInSubmit);

  // Modal Báo Hao Hụt
  document.getElementById('btn-open-spoilage-modal')?.addEventListener('click', () => openSpoilageModal());
  document.getElementById('btn-close-spoilage')?.addEventListener('click', closeSpoilageModal);
  document.getElementById('btn-cancel-spoilage')?.addEventListener('click', closeSpoilageModal);
  document.getElementById('form-spoilage')?.addEventListener('submit', handleSpoilageSubmit);

  // =====================================================================================
  // EVENT LISTENERS: BỘ LỌC NGÀY BÁO CÁO LÃI - LỖ (P&L DATE FILTERING)
  // =====================================================================================
  document.querySelectorAll('.btn-pnl-range').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = btn.getAttribute('data-range');
      setPnlRange(range);
    });
  });

  document.getElementById('pnl-custom-date')?.addEventListener('change', (e) => {
    setPnlCustomDate(e.target.value);
  });

  // =====================================================================================
  // EVENT LISTENERS: QUẢN LÝ NHÂN SỰ & CHẤM CA TÍNH LƯƠNG
  // =====================================================================================
  // Chuyển đổi Sub-tab nhân sự
  document.querySelectorAll('.staff-subnav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const subtab = btn.getAttribute('data-staff-subtab');
      switchStaffSubtab(subtab);
    });
  });

  // Mở & Đóng modal Thêm/Sửa nhân viên
  document.getElementById('btn-open-add-staff-modal')?.addEventListener('click', () => openStaffModal());
  document.getElementById('btn-close-staff-modal')?.addEventListener('click', () => {
    document.getElementById('modal-staff-form')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-staff')?.addEventListener('click', () => {
    document.getElementById('modal-staff-form')?.classList.add('hidden');
  });
  document.getElementById('form-staff')?.addEventListener('submit', handleStaffFormSubmit);

  // Mở & Đóng modal Chấm ca làm việc
  document.getElementById('btn-open-timekeeping-modal')?.addEventListener('click', () => openTimekeepingModal());
  document.getElementById('btn-close-timekeeping-modal')?.addEventListener('click', () => {
    document.getElementById('modal-timekeeping-form')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-timekeeping')?.addEventListener('click', () => {
    document.getElementById('modal-timekeeping-form')?.classList.add('hidden');
  });
  document.getElementById('form-timekeeping')?.addEventListener('submit', handleTimekeepingSubmit);
  document.getElementById('tk-form-ca')?.addEventListener('change', updateTimekeepingShiftPreview);

  // Mở & Đóng modal Thiết lập ca làm việc (CA_LAM_VIEC)
  document.getElementById('btn-open-shift-config-modal')?.addEventListener('click', () => openShiftConfigModal());
  document.getElementById('btn-close-shift-config-modal')?.addEventListener('click', () => {
    document.getElementById('modal-shift-config-form')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-shift-config')?.addEventListener('click', () => {
    document.getElementById('modal-shift-config-form')?.classList.add('hidden');
  });
  document.getElementById('form-shift-config')?.addEventListener('submit', handleShiftConfigSubmit);

  // =====================================================================================
  // EVENT LISTENERS: TRUNG TÂM THÔNG BÁO & CẢNH BÁO TỒN KHO (NOTIFICATION HUB)
  // =====================================================================================
  document.getElementById('btn-stock-alert')?.addEventListener('click', openNotificationsModal);
  document.getElementById('btn-collapsed-alert')?.addEventListener('click', openNotificationsModal);
  document.getElementById('btn-close-notifications')?.addEventListener('click', () => {
    document.getElementById('modal-notifications')?.classList.add('hidden');
  });
  document.getElementById('btn-dismiss-notifications')?.addEventListener('click', () => {
    document.getElementById('modal-notifications')?.classList.add('hidden');
  });
  document.getElementById('btn-goto-inventory-from-notif')?.addEventListener('click', () => {
    document.getElementById('modal-notifications')?.classList.add('hidden');
    switchMainTab('inventory');
  });

  // Chuyển đổi vai trò nhanh khi Sidebar đang thu gọn (Mini Mode)
  document.getElementById('btn-collapsed-role-cycle')?.addEventListener('click', () => {
    const roles = ['QuanLy', 'ThuNgan', 'PhaChe'];
    const curIdx = roles.indexOf(AppState.currentRole);
    const nextRole = roles[(curIdx + 1) % roles.length];
    applyRolePermissions(nextRole);
    showToast(`Đã chuyển sang vai trò: ${nextRole}`);
  });

  // Chuyển đổi Online/Offline khi Sidebar đang thu gọn (Mini Mode)
  document.getElementById('btn-collapsed-offline-toggle')?.addEventListener('click', () => {
    document.getElementById('btn-toggle-offline')?.click();
  });
}

// Mở modal danh sách thông báo và cảnh báo tồn kho
async function openNotificationsModal() {
  const modal = document.getElementById('modal-notifications');
  const container = document.getElementById('notifications-list-container');
  if (!modal || !container) return;

  let lowMaterials = [];
  try {
    const res = await fetch('/api/inventory/materials');
    const data = await res.json();
    if (data.success && data.data) {
      lowMaterials = data.data.filter(m => Number(m.SoLuongTonHienTai) <= Number(m.MucToiThieuCanCanhBao));
    }
  } catch (e) {
    console.error('Lỗi nạp cảnh báo kho:', e);
  }

  let html = '';

  if (lowMaterials.length > 0) {
    html += `
      <div class="space-y-2">
        <span class="text-[11px] font-extrabold uppercase tracking-wider text-rose-700 flex items-center gap-1.5">
          ⚠️ Vật tư tồn kho cần nhập gấp (${lowMaterials.length})
        </span>
        ${lowMaterials.map(m => `
          <div class="p-3 bg-rose-50/70 border border-rose-200 rounded-2xl flex items-center justify-between gap-2 shadow-2xs">
            <div>
              <h4 class="text-xs font-extrabold text-slate-900">${m.TenVatTu}</h4>
              <p class="text-[10px] text-slate-500 font-medium">Mã: <span class="font-mono font-bold">${m.MaVatTu}</span> • Đơn vị: ${m.DonViTinh}</p>
            </div>
            <div class="text-right shrink-0">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-600 text-white font-mono">
                Còn ${Number(m.SoLuongTonHienTai).toLocaleString('vi-VN')} / ${Number(m.MucToiThieuCanCanhBao).toLocaleString('vi-VN')}
              </span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (AppState.stockAlerts.length > 0) {
    html += `
      <div class="space-y-2 mt-3 pt-3 border-t border-slate-100">
        <span class="text-[11px] font-extrabold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
          🔔 Lịch sử cảnh báo thời gian thực (${AppState.stockAlerts.length})
        </span>
        ${AppState.stockAlerts.map(a => `
          <div class="p-2.5 bg-amber-50/70 border border-amber-200 rounded-xl text-xs flex items-center justify-between">
            <span class="font-semibold text-slate-800">${a.tenVatTu || 'Vật tư'}</span>
            <span class="font-mono text-[11px] text-amber-900 font-bold">Còn ${a.soLuongTonHienTai || 0} ${a.donViTinh || ''}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (!html) {
    html = `
      <div class="text-center py-8 text-slate-400 space-y-2">
        <div class="text-3xl">☕</div>
        <p class="text-xs font-bold text-slate-700">Tất cả nguyên vật liệu đều đang ở mức an toàn!</p>
        <p class="text-[11px] text-slate-400">Không có cảnh báo tồn kho hay sự cố nào cần xử lý.</p>
      </div>
    `;
  }

  container.innerHTML = html;
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}


function updateNetworkBadge(isOnline) {
  const dot = document.getElementById('network-status-dot');
  const dotMini = document.getElementById('network-status-dot-mini');
  const text = document.getElementById('network-status-text');

  if (isOnline) {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 shadow-xs animate-pulse shrink-0';
    if (dotMini) dotMini.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
    if (text) {
      text.textContent = 'Trực tuyến';
      text.className = 'text-[10px] font-bold text-emerald-700';
    }
  } else {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500 shadow-xs shrink-0';
    if (dotMini) dotMini.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
    if (text) {
      text.textContent = 'Ngoại tuyến';
      text.className = 'text-[10px] font-bold text-rose-700';
    }
  }
}

// Toast notification helper
function showToast(message, type = 'info') {
  const existing = document.getElementById('pos-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'pos-toast';
  let bg = 'bg-slate-900 text-white border-slate-700';
  if (type === 'success') bg = 'bg-emerald-800 text-white border-emerald-600';
  if (type === 'warning') bg = 'bg-amber-800 text-white border-amber-600';
  if (type === 'error') bg = 'bg-rose-800 text-white border-rose-600';

  toast.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-2xl border shadow-2xl text-xs font-bold flex items-center gap-2.5 ${bg} animate-bounce`;
  toast.innerHTML = `<span>🔔</span> <span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}


// =====================================================================================
// AUTHENTICATION & LOGIN / LOGOUT MANAGEMENT (PHÂN QUYỀN BẢO MẬT RBAC)
// =====================================================================================
function openLoginModal() {
  const modal = document.getElementById('modal-login');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
  }
  const alert = document.getElementById('login-error-alert');
  if (alert) alert.classList.add('hidden');
}

function closeLoginModal() {
  const modal = document.getElementById('modal-login');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.display = 'none';
  }
}

async function handleLoginSubmit(e) {
  if (e) {
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorAlert = document.getElementById('login-error-alert');
  const errorText = document.getElementById('login-error-text');
  const submitBtn = document.getElementById('btn-submit-login');
  const submitText = document.getElementById('btn-submit-login-text');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!username || !password) {
    if (errorAlert && errorText) {
      errorText.textContent = 'Vui lòng nhập tên đăng nhập và mật khẩu!';
      errorAlert.classList.remove('hidden');
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = 'ĐANG ĐĂNG NHẬP...';

  try {
    const res = await _nativeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success && data.data) {
      const { token, user } = data.data;
      localStorage.setItem('pho_xanh_token', token);
      localStorage.setItem('pho_xanh_user', JSON.stringify(user));
      localStorage.setItem('pho_xanh_user_role', user.vaiTro);

      AppState.currentUser = user;
      AppState.currentRole = user.vaiTro;

      closeLoginModal();
      applyRolePermissions(user.vaiTro, false);

      // Cập nhật tên hiển thị ở header & sidebar ngay lập tức
      const nameEl = document.getElementById('current-user-name');
      if (nameEl) {
        const cleanName = (user.hoTen || '').replace(/\s*\([^)]*\)$/, '').trim();
        nameEl.textContent = cleanName || user.hoTen;
      }

      // Nạp lại dữ liệu với vai trò và phiên đăng nhập mới
      try {
        await loadInitialData();
      } catch (loadErr) {
        console.warn('Lỗi khi nạp lại dữ liệu sau đăng nhập:', loadErr);
      }
      renderPosTableTabs();
      renderFloorTables();
      if (typeof loadKdsOrders === 'function') {
        loadKdsOrders();
      }

      // Điều hướng tới tab: ưu tiên tab trên URL nếu có quyền, ngược lại theo vai trò
      const allowedTabsByRole = {
        ChuQuan: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
        QuanLy: ['pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'reports', 'shift', 'printer'],
        PhaChe: ['kds', 'recipes', 'schedule'],
        ThuNgan: ['pos', 'shift', 'schedule', 'printer']
      };
      const userAllowed = allowedTabsByRole[user.vaiTro] || ['pos'];
      const targetFromUrl = getTabFromPath();
      const defaultLandingTab = (targetFromUrl && userAllowed.includes(targetFromUrl))
        ? targetFromUrl
        : ({
            ChuQuan: 'pos',
            QuanLy: 'pos',
            PhaChe: 'kds',
            ThuNgan: 'pos'
          }[user.vaiTro] || 'pos');

      navigateToTab(defaultLandingTab, true);
      showToast(`🎉 ${data.message}`, 'success');
    } else {
      if (errorAlert && errorText) {
        errorText.textContent = data.message || 'Đăng nhập không thành công!';
        errorAlert.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (errorAlert && errorText) {
      errorText.textContent = 'Không thể kết nối đến máy chủ! Vui lòng thử lại.';
      errorAlert.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = 'ĐĂNG NHẬP HỆ THỐNG';
  }
}

async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}

  localStorage.removeItem('pho_xanh_token');
  localStorage.removeItem('pho_xanh_user');
  localStorage.removeItem('pho_xanh_user_role');

  AppState.currentUser = null;
  openLoginModal();
  showToast('Đã đăng xuất khỏi hệ thống an toàn!', 'info');
}

function quickFillLogin(username, password) {
  const uInput = document.getElementById('login-username');
  const pInput = document.getElementById('login-password');
  if (uInput) uInput.value = username;
  if (pInput) pInput.value = password;
  return handleLoginSubmit();
}

window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.handleLoginSubmit = handleLoginSubmit;
window.handleLogout = handleLogout;
window.quickFillLogin = quickFillLogin;

// =====================================================================================
// SMART AUTO-HIDE TOP HEADER (ẨN KHI CUỘN XUỐNG XEM MÓN, HIỆN KHI CUỘN NGƯỢC LÊN)
// =====================================================================================
const _scrollTrackMap = new WeakMap();

function setHeaderVisibility(visible) {
  const header = document.getElementById('main-top-header') || document.querySelector('header');
  if (!header) return;
  if (visible) {
    header.classList.remove('header-hidden');
  } else {
    // Không ẩn header nếu modal đăng nhập hoặc modal thanh toán đang mở
    const loginModal = document.getElementById('modal-login');
    if (loginModal && loginModal.style.display !== 'none' && !loginModal.classList.contains('hidden')) {
      return;
    }
    header.classList.add('header-hidden');
  }
}

function initSmartHeaderScroll() {
  const header = document.getElementById('main-top-header') || document.querySelector('header');
  if (!header) return;

  // Lắng nghe sự kiện scroll ở capturing phase để bắt mọi container có overflow-y-auto (menu món, bàn, tab...)
  window.addEventListener('scroll', (e) => {
    const target = e.target;
    if (!target) return;

    let elem = null;
    let currentY = 0;

    if (target === document || target === window || target === document.documentElement || target === document.body) {
      elem = document.documentElement;
      currentY = window.scrollY || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
    } else if (target instanceof HTMLElement) {
      // Bỏ qua cuộn bên trong Sidebar menu trái hoặc trong các Modal popup
      if (target.closest('#sidebar') || target.closest('#modal-pos-cart') || target.closest('#modal-checkout') || target.closest('#modal-login') || target.closest('.modal')) {
        return;
      }
      elem = target;
      currentY = target.scrollTop;
    }

    if (!elem || typeof currentY !== 'number') return;

    const lastY = _scrollTrackMap.get(elem) || 0;
    const delta = currentY - lastY;

    // Khi ở ngay đỉnh (<= 25px) -> Luôn hiện thanh tiêu đề
    if (currentY <= 25) {
      setHeaderVisibility(true);
      _scrollTrackMap.set(elem, Math.max(0, currentY));
      return;
    }

    // Cuộn xuống xem món (delta > 15px) -> Ẩn thanh trên để mở rộng tối đa không gian
    if (delta > 15) {
      setHeaderVisibility(false);
    }
    // Cuộn ngược lên (lướt ngón tay xuống, delta < -12px) -> Hiện lại thanh trên
    else if (delta < -12) {
      setHeaderVisibility(true);
    }

    _scrollTrackMap.set(elem, Math.max(0, currentY));
  }, { capture: true, passive: true });

  // Tiện ích chuột trên máy tính: Di chuột lên sát mép trên cùng (clientY <= 15px) tự động hiện thanh header
  window.addEventListener('mousemove', (e) => {
    if (e.clientY <= 15) {
      setHeaderVisibility(true);
    }
  }, { passive: true });
}

window.setHeaderVisibility = setHeaderVisibility;
window.initSmartHeaderScroll = initSmartHeaderScroll;

// =====================================================================================
// BOOTSTRAP RUNNER & POPSTATE LISTENER (ĐẶT Ở CUỐI CÙNG SAU KHI TOÀN BỘ CODE ĐÃ SẴN SÀNG)
// =====================================================================================
async function bootstrapApp() {
  // 1. Kiểm tra phiên đăng nhập đã lưu
  const savedToken = localStorage.getItem('pho_xanh_token');
  const savedUserJson = localStorage.getItem('pho_xanh_user');
  let isLoggedIn = false;

  if (savedToken && savedUserJson) {
    try {
      const user = JSON.parse(savedUserJson);
      if (user && user.vaiTro) {
        AppState.currentUser = user;
        AppState.currentRole = user.vaiTro;
        isLoggedIn = true;
      }
    } catch (e) {}
  }

  initClock();
  initWebSocket();
  initEventHandlers();
  initSmartHeaderScroll();

  // Đăng ký event handler cho Form Login
  document.getElementById('form-login')?.addEventListener('submit', handleLoginSubmit);

  try {
    await loadInitialData();
  } catch (err) {
    console.error('Lỗi khi nạp dữ liệu ban đầu:', err);
  }

  if (!isLoggedIn && !AppState.currentUser) {
    // Chưa đăng nhập: Mở Login Modal và áp dụng quyền mặc định hạn chế
    openLoginModal();
    applyRolePermissions(AppState.currentRole || 'QuanLy', false);
    return;
  }

  // Đã có phiên đăng nhập hợp lệ
  closeLoginModal();
  applyRolePermissions(AppState.currentRole, false);
  renderPosTableTabs();
  renderFloorTables();

  // URL ROUTING ENGINE: Kích hoạt tab tương ứng với URL trên thanh địa chỉ trình duyệt
  const targetTab = getTabFromPath() || (AppState.currentRole === 'PhaChe' ? 'kds' : 'pos');
  navigateToTab(targetTab, false);

  if (window.lucide) {
    try { window.lucide.createIcons(); } catch (e) {}
  }
}

// Lắng nghe sự kiện Back / Forward của trình duyệt để đổi tab mượt mà
window.addEventListener('popstate', () => {
  const targetTab = getTabFromPath() || (AppState.currentRole === 'PhaChe' ? 'kds' : 'pos');
  navigateToTab(targetTab, false);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
