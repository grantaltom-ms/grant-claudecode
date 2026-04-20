import { useState, useEffect } from 'react';
import { loadDeals, deleteDeal } from '../lib/supabase';

function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

export default function SavedDeals({ onLoadDeal }) {
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDeals = async () => {
    setLoading(true);
    try {
      const data = await loadDeals();
      setDeals(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDeals(); }, []);

  const handleDelete = async (id) => {
    try {
      await deleteDeal(id);
      setDeals(prev => prev.filter(d => d.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Loading saved deals...</p>;
  if (error) return <p className="text-sm text-red-500">Error: {error}</p>;
  if (deals.length === 0) return <p className="text-sm text-slate-500">No saved deals yet. Underwrite a deal and click "Save to Database".</p>;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Saved Deals</h2>
      <div className="grid gap-3">
        {deals.map(deal => (
          <div key={deal.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
            <div className="flex-1">
              <h3 className="font-semibold text-slate-900">{deal.deal_name}</h3>
              <p className="text-xs text-slate-500">
                {deal.address && `${deal.address} | `}
                {deal.market} | {new Date(deal.created_at).toLocaleDateString()}
              </p>
              <div className="flex gap-4 mt-2 text-xs text-slate-600">
                <span>Price: <strong>{fmt$(deal.purchase_price)}</strong></span>
                <span>Cap: <strong>{deal.cap_rate?.toFixed(2)}%</strong></span>
                <span>CoC: <strong>{deal.cash_on_cash?.toFixed(2)}%</strong></span>
                <span>DSCR: <strong>{deal.dscr?.toFixed(2)}x</strong></span>
              </div>
            </div>
            <div className="flex gap-2 ml-4">
              <button
                onClick={() => onLoadDeal(deal)}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Load
              </button>
              <button
                onClick={() => handleDelete(deal.id)}
                className="px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
