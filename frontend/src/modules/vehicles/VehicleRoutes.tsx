/**
 * Vehicle Module Routes
 *
 * Placeholder — will be replaced with the VM's VehicleRoutes.tsx containing
 * all 13 routes (dashboard, fleet, book-out, check-in, allocations, prep,
 * issues, fleet-map, settings, etc.)
 */
import { Routes, Route } from 'react-router-dom';

function VehiclePlaceholder({ page }: { page: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-8 text-center">
      <h2 className="text-xl font-semibold text-gray-700 mb-2">Vehicles — {page}</h2>
      <p className="text-gray-500">
        Vehicle Module integration in progress. This page will be available once the VM source is mounted.
      </p>
    </div>
  );
}

export default function VehicleRoutes() {
  return (
    <Routes>
      <Route index element={<VehiclePlaceholder page="Dashboard" />} />
      <Route path="fleet" element={<VehiclePlaceholder page="Fleet" />} />
      <Route path="book-out" element={<VehiclePlaceholder page="Book Out" />} />
      <Route path="book-out/:id" element={<VehiclePlaceholder page="Book Out Detail" />} />
      <Route path="check-in" element={<VehiclePlaceholder page="Check In" />} />
      <Route path="check-in/:id" element={<VehiclePlaceholder page="Check In Detail" />} />
      <Route path="allocations" element={<VehiclePlaceholder page="Allocations" />} />
      <Route path="prep" element={<VehiclePlaceholder page="Prep" />} />
      <Route path="issues" element={<VehiclePlaceholder page="Issues" />} />
      <Route path="fleet-map" element={<VehiclePlaceholder page="Fleet Map" />} />
      <Route path="settings" element={<VehiclePlaceholder page="Settings" />} />
      <Route path="hire-agreement/:id" element={<VehiclePlaceholder page="Hire Agreement" />} />
      <Route path="collection/:id" element={<VehiclePlaceholder page="Collection" />} />
    </Routes>
  );
}
