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
import Purchase from './pages/Purchase.jsx';
import Sales from './pages/Sales.jsx';
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

        <Route path="purchase" element={<Purchase />} />
        <Route path="sales" element={<Sales />} />

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
