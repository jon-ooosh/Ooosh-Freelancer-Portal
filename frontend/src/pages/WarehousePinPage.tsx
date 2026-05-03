/**
 * Warehouse PIN entry — kiosk gate.
 *
 * Standalone page (no Layout wrapper). Sole job: take a PIN, hand it to
 * /api/warehouse/auth/pin, store the returned JWT, send the kiosk into
 * /warehouse/collections.
 *
 * If a valid token already lives in sessionStorage (kiosk left open),
 * we skip the form and redirect immediately.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getWarehouseToken, setWarehouseToken } from '../services/warehouseSession';

export default function WarehousePinPage() {
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Skip form if we've already got a session
  useEffect(() => {
    if (getWarehouseToken()) {
      navigate('/warehouse/collections', { replace: true });
    }
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length < 4) {
      setError('PIN must be at least 4 digits');
      return;
    }
    setIsSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/warehouse/auth/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await response.json();
      if (!response.ok || !data.token) {
        setError(data.error || 'Incorrect PIN');
        setPin('');
        return;
      }
      setWarehouseToken(data.token);
      navigate('/warehouse/collections', { replace: true });
    } catch (err) {
      console.error('PIN auth error:', err);
      setError('Failed to verify PIN. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePinChange(e: React.ChangeEvent<HTMLInputElement>) {
    setPin(e.target.value.replace(/\D/g, ''));
    setError('');
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-purple-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/ooosh-logo.svg"
            alt="Ooosh Tours"
            className="h-16 mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-gray-800">Warehouse Collections</h1>
          <p className="text-gray-500 mt-2">Enter PIN to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={handlePinChange}
              placeholder="Enter PIN"
              className={`w-full text-center text-3xl tracking-[0.5em] py-4 px-6 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 transition-colors ${
                error ? 'border-red-300 bg-red-50' : 'border-gray-200'
              }`}
              maxLength={8}
              autoFocus
              disabled={isSubmitting}
            />
            {error && <p className="mt-2 text-center text-red-600 text-sm">{error}</p>}
          </div>

          <button
            type="submit"
            disabled={isSubmitting || pin.length < 4}
            className="w-full bg-purple-600 text-white py-4 rounded-xl font-semibold text-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Verifying…' : 'Continue'}
          </button>
        </form>

        <p className="text-center text-gray-400 text-sm mt-8">For staff use only</p>
      </div>
    </div>
  );
}
