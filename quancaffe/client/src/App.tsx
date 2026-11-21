import { useState } from 'react'
import './App.css'

interface MenuItem {
  id: string
  name: string
  category: string
  price: number
  description: string
}

interface CartItem extends MenuItem {
  quantity: number
}

const MENU_ITEMS: MenuItem[] = [
  { id: 'cf-1', name: 'Cà phê Đen Đá', category: 'Cà phê truyền thống', price: 25000, description: 'Hạt Robusta Buôn Ma Thuột rang đậm, đậm vị truyền thống' },
  { id: 'cf-2', name: 'Cà phê Sữa Đá', category: 'Cà phê truyền thống', price: 29000, description: 'Sữa đặc béo ngậy hoà quyện cà phê phin đậm đà' },
  { id: 'cf-3', name: 'Bạc Xỉu Sài Gòn', category: 'Cà phê truyền thống', price: 32000, description: 'Nhiều sữa ít cà phê, béo thơm dễ uống' },
  { id: 'es-1', name: 'Espresso Doppio', category: 'Espresso Bar', price: 35000, description: 'Chiết xuất kép 36g, lớp crema dày mịn chuẩn Italy' },
  { id: 'es-2', name: 'Americano Đá', category: 'Espresso Bar', price: 35000, description: 'Espresso pha loãng nước tinh khiết mát lạnh' },
  { id: 'es-3', name: 'Cappuccino Nóng', category: 'Espresso Bar', price: 45000, description: 'Lớp bọt sữa bông mịn rắc bột quế thơm nồng' },
  { id: 'tea-1', name: 'Trà Sen Vàng Hạt Sen', category: 'Trà & Trái cây', price: 45000, description: 'Trà ô long thanh mát kèm hạt sen bùi ngọt tự nhiên' },
  { id: 'tea-2', name: 'Cold Brew Cam Vàng', category: 'Trà & Trái cây', price: 42000, description: 'Ủ lạnh 18 giờ cùng lát cam sành mọng nước' },
  { id: 'snack-1', name: 'Croissant Bơ Pháp', category: 'Bánh tươi', price: 38000, description: 'Bánh sừng bò ngàn lớp nướng giòn tan' },
]

const CATEGORIES = ['Tất cả', 'Cà phê truyền thống', 'Espresso Bar', 'Trà & Trái cây', 'Bánh tươi']

export default function App() {
  const [selectedCategory, setSelectedCategory] = useState('Tất cả')
  const [cart, setCart] = useState<CartItem[]>([
    { ...MENU_ITEMS[1], quantity: 2 },
    { ...MENU_ITEMS[3], quantity: 1 },
  ])
  const [tableNumber] = useState('04')

  const filteredItems = selectedCategory === 'Tất cả'
    ? MENU_ITEMS
    : MENU_ITEMS.filter((item) => item.category === selectedCategory)

  const addToCart = (item: MenuItem) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === item.id)
      if (existing) {
        return prev.map((i) => (i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i))
      }
      return [...prev, { ...item, quantity: 1 }]
    })
  }

  const updateQuantity = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) => (i.id === id ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0)
    )
  }

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const vat = Math.round(subtotal * 0.08)
  const total = subtotal + vat

  return (
    <div className="pos-app">
      {/* Header Bar */}
      <header className="pos-header">
        <div className="brand">
          <div className="brand-mark">☕</div>
          <div>
            <h1 className="brand-title">Phố Xanh Coffee</h1>
            <p className="brand-sub">Quầy thanh toán & Gọi món nhanh</p>
          </div>
        </div>
        <div className="header-meta">
          <span className="badge-table">Bàn {tableNumber}</span>
          <span className="badge-online">Online</span>
        </div>
      </header>

      {/* Main Split Layout */}
      <div className="pos-body">
        {/* Left Side: Menu */}
        <main className="pos-menu-section">
          {/* Category Filter Pills */}
          <nav className="category-bar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`category-pill ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </nav>

          {/* Menu Items Grid */}
          <div className="menu-grid">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="menu-card"
                onClick={() => addToCart(item)}
                role="button"
                tabIndex={0}
              >
                <div className="menu-card-header">
                  <span className="menu-category">{item.category}</span>
                  <span className="menu-price">{item.price.toLocaleString('vi-VN')} đ</span>
                </div>
                <h3 className="menu-name">{item.name}</h3>
                <p className="menu-desc">{item.description}</p>
                <div className="menu-card-footer">
                  <span className="add-hint">+ Thêm vào order</span>
                </div>
              </div>
            ))}
          </div>
        </main>

        {/* Right Side: Order Cart & Ticket */}
        <aside className="pos-cart-section">
          <div className="cart-header">
            <div>
              <h2 className="cart-title">Order hiện tại</h2>
              <p className="cart-sub">Bàn số {tableNumber} • 3 món</p>
            </div>
            <button
              type="button"
              className="btn-clear"
              onClick={() => setCart([])}
              disabled={cart.length === 0}
            >
              Xoá tất cả
            </button>
          </div>

          {/* Cart Items List */}
          <div className="cart-items">
            {cart.length === 0 ? (
              <div className="cart-empty">Chưa có món nào trong order</div>
            ) : (
              cart.map((item) => (
                <div key={item.id} className="cart-row">
                  <div className="cart-row-info">
                    <span className="cart-item-name">{item.name}</span>
                    <span className="cart-item-unit">
                      {item.price.toLocaleString('vi-VN')} đ
                    </span>
                  </div>
                  <div className="cart-row-controls">
                    <div className="qty-picker">
                      <button
                        type="button"
                        onClick={() => updateQuantity(item.id, -1)}
                        aria-label="Giảm"
                      >
                        -
                      </button>
                      <span className="qty-value">{item.quantity}</span>
                      <button
                        type="button"
                        onClick={() => updateQuantity(item.id, 1)}
                        aria-label="Tăng"
                      >
                        +
                      </button>
                    </div>
                    <span className="cart-item-subtotal">
                      {(item.price * item.quantity).toLocaleString('vi-VN')} đ
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Bill Summary Ticket */}
          <div className="cart-summary">
            <div className="summary-line">
              <span>Tạm tính</span>
              <span className="mono-num">{subtotal.toLocaleString('vi-VN')} đ</span>
            </div>
            <div className="summary-line">
              <span>Thuế GTGT (8%)</span>
              <span className="mono-num">{vat.toLocaleString('vi-VN')} đ</span>
            </div>
            <div className="summary-line total">
              <span>Tổng cộng</span>
              <span className="mono-num total-price">{total.toLocaleString('vi-VN')} đ</span>
            </div>

            <button
              type="button"
              className="btn-checkout"
              disabled={cart.length === 0}
            >
              In hoá đơn & Thanh toán
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}
