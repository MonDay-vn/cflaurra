import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import cors from 'cors';
import { initDatabase } from './db/database.js';
import { kdsHub } from './sockets/kdsHub.js';
import { authMiddleware, requireRoles } from './middlewares/auth.js';
import { OrderController } from './controllers/orderController.js';
import { MenuController } from './controllers/menuController.js';
import { InventoryController } from './controllers/inventoryController.js';
import { ShiftController } from './controllers/shiftController.js';
import { ReportController } from './controllers/reportController.js';
import { CustomerController } from './controllers/customerController.js';
import { EmployeeController } from './controllers/employeeController.js';
import { AuthController } from './controllers/authController.js';

const app = express();
const server = http.createServer(app);

// Khởi tạo Database SQLite 23 bảng & Seed data
initDatabase();

// Khởi tạo WebSocket Server cho Real-time KDS & POS
kdsHub.init(server);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Phục vụ giao diện tĩnh Frontend (POS & KDS) - Vô hiệu hóa cache trình duyệt để luôn nhận code mới nhất
const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Logger
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});

// Auth middleware để nhận diện vai trò người dùng
app.use('/api', authMiddleware);

// --- 0. AUTHENTICATION (ĐĂNG NHẬP & BẢO MẬT PHÂN QUYỀN RBAC) ---
app.post('/api/auth/login', AuthController.login);
app.post('/api/auth/register', AuthController.register);
app.post('/api/auth/logout', AuthController.logout);
app.get('/api/auth/me', AuthController.getMe);

// --- 1. MENU & TABLE ROUTES ---
app.get('/api/menu', MenuController.getMenu);
app.post('/api/menu/items', requireRoles('ChuQuan', 'QuanLy'), MenuController.createMenuItem);
app.put('/api/menu/items/:id', requireRoles('ChuQuan', 'QuanLy'), MenuController.updateMenuItem);
app.patch('/api/menu/items/:id/toggle-stock', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan', 'PhaChe'), MenuController.toggleMenuItemStock);
app.post('/api/menu/items/:id/toggle-stock', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan', 'PhaChe'), MenuController.toggleMenuItemStock);
app.put('/api/menu/items/:id/availability', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan', 'PhaChe'), MenuController.toggleMenuItemStock);
app.delete('/api/menu/items/:id', requireRoles('ChuQuan', 'QuanLy'), MenuController.deleteMenuItem);
app.get('/api/tables', MenuController.getTables);
app.get('/api/tables/:id/order', OrderController.getTableActiveOrder);
app.put('/api/tables/:id/status', MenuController.updateTableStatus);
app.post('/api/tables/transfer', MenuController.transferTable);
app.post('/api/tables/merge', MenuController.mergeTables);

// --- 2. ORDER & BILLING ROUTES ---
// Các route cụ thể đặt trước route tham số :id
app.get('/api/orders/kds', OrderController.getKdsTickets);
app.get('/api/orders/cancellations', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), OrderController.getCancelHistory);
app.post('/api/orders/reconciliation', OrderController.reconcileOfflineOrders);
app.post('/api/orders/cancel-item', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), OrderController.cancelItem);
app.get('/api/orders', OrderController.getOrderHistory);
app.get('/api/orders/:id', OrderController.getOrderById);
app.post('/api/orders', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), OrderController.createOrder);
app.post('/api/orders/:id/pay', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), OrderController.payOrder);
app.put('/api/orders/kds/items/batch-status', OrderController.updateKdsBatchStatus);
app.post('/api/orders/kds/:id/complete-all', OrderController.completeEntireOrder);
app.put('/api/orders/kds/items/:itemId/status', OrderController.updateKdsItemStatus);
app.get('/api/orders/:id/receipt', OrderController.getReceipt);

// --- 3. INVENTORY & RECIPES ---
app.get('/api/inventory/materials', InventoryController.getMaterials);
app.get('/api/inventory/recipes', InventoryController.getRecipes);
app.post('/api/inventory/recipes', requireRoles('ChuQuan', 'QuanLy', 'PhaChe'), InventoryController.createRecipe);
app.put('/api/inventory/recipes/:id', requireRoles('ChuQuan', 'QuanLy', 'PhaChe'), InventoryController.updateRecipe);
app.delete('/api/inventory/recipes/:id', requireRoles('ChuQuan', 'QuanLy', 'PhaChe'), InventoryController.deleteRecipe);
app.get('/api/inventory/suppliers', InventoryController.getSuppliers);
app.post('/api/inventory/import', requireRoles('ChuQuan', 'QuanLy'), InventoryController.importStock);
app.post('/api/inventory/spoilage', requireRoles('ChuQuan', 'QuanLy'), InventoryController.reportLoss);

// --- 4. SHIFT & CASH DRAWER BALANCING & SHIFT CONFIGURATION ---
app.get('/api/shift/current', ShiftController.getCurrentShift);
app.get('/api/shift/history', ShiftController.getShiftHistory);
app.get('/api/shift/last-closed', ShiftController.getLastClosedShift);
app.post('/api/shift/open', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), ShiftController.openShift);
app.post('/api/shift/close', requireRoles('ChuQuan', 'QuanLy', 'ThuNgan'), ShiftController.closeShift);
app.post('/api/shift/approve', requireRoles('QuanLy', 'ChuQuan'), ShiftController.approveShift);
app.get('/api/shifts/configs', ShiftController.getShiftConfigs);
app.post('/api/shifts/configs', requireRoles('ChuQuan', 'QuanLy'), ShiftController.createShiftConfig);
app.put('/api/shifts/configs/:id', requireRoles('ChuQuan', 'QuanLy'), ShiftController.updateShiftConfig);
app.delete('/api/shifts/configs/:id', requireRoles('ChuQuan', 'QuanLy'), ShiftController.deleteShiftConfig);
app.get('/api/shifts/schedule', ShiftController.getShiftSchedule);
app.post('/api/shifts/schedule', requireRoles('ChuQuan', 'QuanLy'), ShiftController.assignShiftSchedule);
app.delete('/api/shifts/schedule/:id', requireRoles('ChuQuan', 'QuanLy'), ShiftController.deleteShiftSchedule);

// --- 5. REPORTING (P&L) ---
app.get('/api/reports/pnl', requireRoles('ChuQuan', 'QuanLy'), ReportController.getProfitAndLoss);

// --- 6. CUSTOMER & EMPLOYEES CRUD (CHỦ QUÁN & QUẢN LÝ ĐƯỢC PHÉP QUẢN TRỊ NHÂN SỰ) ---
app.get('/api/customers/search', CustomerController.searchByPhone);
app.get('/api/employees', EmployeeController.getEmployees);
app.get('/api/employees/metadata', EmployeeController.getMetadata);
app.post('/api/employees', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.createEmployee);
app.put('/api/employees/:id', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.updateEmployee);
app.delete('/api/employees/:id', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.deleteEmployee);

// --- 7. SHIFT TIMEKEEPING & PAYROLL (CHẤM CA & TÍNH LƯƠNG THEO CA) ---
app.get('/api/payroll/timekeeping', EmployeeController.getTimekeepingLogs);
app.post('/api/payroll/timekeeping', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.recordTimekeeping);
app.delete('/api/payroll/timekeeping/:id', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.deleteTimekeeping);
app.get('/api/payroll/summary', requireRoles('ChuQuan', 'QuanLy'), EmployeeController.getPayrollSummary);

// --- 8. FRONTEND URL ROUTING (MỖI TAB LÀ MỘT URL RIÊNG BIỆT) ---
const TAB_ROUTES = ['', 'pos', 'kds', 'recipes', 'inventory', 'staff', 'schedule', 'shift', 'reports', 'printer'];
TAB_ROUTES.forEach(tab => {
  const route = tab ? `/${tab}` : '/';
  app.get(route, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
});

// Root health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    system: 'F&B POS & KDS Coffee Shop Management'
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIps: string[] = [];
  for (const n of Object.keys(nets)) {
    for (const net of nets[n] || []) {
      if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
    }
  }

  console.log(`=======================================================`);
  console.log(` Coffee Shop F&B POS Web UI & API running on:`);
  console.log(` -> Máy tính này (Local):     http://localhost:${PORT}`);
  lanIps.forEach(ip => {
    console.log(` -> Mạng nội bộ/Wi-Fi (LAN):  http://${ip}:${PORT}`);
  });
  console.log(` -> WebSocket Hub:            ws://localhost:${PORT}/ws`);
  console.log(` -> API Health:               http://localhost:${PORT}/api/health`);
  console.log(`=======================================================`);
});

export { app, server };
