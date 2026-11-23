import { Routes, Route } from 'react-router-dom';
import Shell from './components/Shell.jsx';

import Dashboard from './pages/Dashboard.jsx';
import ProductMaster from './pages/ProductMaster.jsx';
import Categories from './pages/Categories.jsx';
import Inventory from './pages/Inventory.jsx';
import StockInward from './pages/StockInward.jsx';
import StockOutward from './pages/StockOutward.jsx';
import StockAdjustments from './pages/StockAdjustments.jsx';
import StockLedger from './pages/StockLedger.jsx';
import Transfers from './pages/Transfers.jsx';
import Reconciliation from './pages/Reconciliation.jsx';
import Warehouses from './pages/Warehouses.jsx';
import PurchaseDashboard from './pages/PurchaseDashboard.jsx';
import Suppliers from './pages/Suppliers.jsx';
import PurchaseOrders from './pages/PurchaseOrders.jsx';
import GoodsReceipts from './pages/GoodsReceipts.jsx';
import SupplierInvoices from './pages/SupplierInvoices.jsx';
import PurchaseReturns from './pages/PurchaseReturns.jsx';
import PurchaseHistory from './pages/PurchaseHistory.jsx';
import SalesDashboard from './pages/SalesDashboard.jsx';
import Customers from './pages/Customers.jsx';
import Quotations from './pages/Quotations.jsx';
import SalesOrders from './pages/SalesOrders.jsx';
import SalesInvoices from './pages/SalesInvoices.jsx';
import DeliveryChallans from './pages/DeliveryChallans.jsx';
import SalesReturns from './pages/SalesReturns.jsx';
import CustomerPayments from './pages/CustomerPayments.jsx';
import SalesHistory from './pages/SalesHistory.jsx';
import Reports from './pages/Reports.jsx';
import SyncStatus from './pages/SyncStatus.jsx';
import Transfer from './pages/Transfer.jsx';
import Users from './pages/Users.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';

/* ============================================================
   ROUTES
   ============================================================
   One route per module in data/modules.js, all nested under the
   shell so every screen gets the same sidebar, topbar and gutter.
   ============================================================ */

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />

        <Route path="products" element={<ProductMaster />} />
        <Route path="categories" element={<Categories />} />

        <Route path="inventory" element={<Inventory />} />
        <Route path="inward" element={<StockInward />} />
        <Route path="outward" element={<StockOutward />} />
        <Route path="adjustments" element={<StockAdjustments />} />
        <Route path="ledger" element={<StockLedger />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="transfers" element={<Transfers />} />
        <Route path="reconciliation" element={<Reconciliation />} />

        <Route path="purchase" element={<PurchaseDashboard />} />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="purchase-orders" element={<PurchaseOrders />} />
        <Route path="goods-receipts" element={<GoodsReceipts />} />
        <Route path="supplier-invoices" element={<SupplierInvoices />} />
        <Route path="purchase-returns" element={<PurchaseReturns />} />
        <Route path="purchase-history" element={<PurchaseHistory />} />

        <Route path="sales" element={<SalesDashboard />} />
        <Route path="customers" element={<Customers />} />
        <Route path="quotations" element={<Quotations />} />
        <Route path="sales-orders" element={<SalesOrders />} />
        <Route path="sales-invoices" element={<SalesInvoices />} />
        <Route path="delivery-challans" element={<DeliveryChallans />} />
        <Route path="sales-returns" element={<SalesReturns />} />
        <Route path="customer-payments" element={<CustomerPayments />} />
        <Route path="sales-history" element={<SalesHistory />} />

        <Route path="reports" element={<Reports />} />

        <Route path="sync" element={<SyncStatus />} />
        <Route path="transfer" element={<Transfer />} />

        <Route path="users" element={<Users />} />
        <Route path="settings" element={<Settings />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
