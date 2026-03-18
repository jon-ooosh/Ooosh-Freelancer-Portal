/**
 * CostReportPage — fleet-wide cost reporting (service + fuel).
 * Admin/manager only. Supports date range filtering and CSV export.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { fetchFleetCosts } from '../lib/fuel-log-api'

export function CostReportPage() {
  const currentYear = new Date().getFullYear()
  const [fromDate, setFromDate] = useState(`${currentYear}-01-01`)
  const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]!)
  const [sortBy, setSortBy] = useState<'totalCost' | 'reg' | 'serviceCost' | 'fuelCost'>('totalCost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['fleet-costs', fromDate, toDate],
    queryFn: () => fetchFleetCosts(fromDate, toDate),
  })

  const sorted = (report?.data || []).slice().sort((a, b) => {
    const aVal = sortBy === 'reg' ? a.reg : a[sortBy]
    const bVal = sortBy === 'reg' ? b.reg : b[sortBy]
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
  })

  function toggleSort(field: typeof sortBy) {
    if (sortBy === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(field)
      setSortDir('desc')
    }
  }

  function exportCsv() {
    if (!sorted.length) return
    const headers = ['Reg', 'Make', 'Model', 'Type', 'Service Cost', 'Service Count', 'Fuel Cost', 'Fuel Count', 'Total Cost']
    const rows = sorted.map(r => [
      r.reg, r.make, r.model, r.simpleType,
      r.serviceCost.toFixed(2), r.serviceCount, r.fuelCost.toFixed(2), r.fuelCount, r.totalCost.toFixed(2),
    ])
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fleet-costs-${fromDate}-to-${toDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Link to={vmPath('/')} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-ooosh-navy">Fleet Cost Report</h2>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!sorted.length}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {/* Date range selector */}
      <div className="flex items-center gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">From</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">To</label>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
        {/* Quick presets */}
        <div className="flex items-end gap-1.5 pb-0.5">
          {[
            { label: 'YTD', from: `${currentYear}-01-01`, to: new Date().toISOString().split('T')[0]! },
            { label: 'Last 30d', from: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]!, to: new Date().toISOString().split('T')[0]! },
            { label: 'Last 90d', from: new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]!, to: new Date().toISOString().split('T')[0]! },
          ].map(preset => (
            <button
              key={preset.label}
              type="button"
              onClick={() => { setFromDate(preset.from); setToDate(preset.to) }}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                fromDate === preset.from && toDate === preset.to
                  ? 'bg-ooosh-navy text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Totals */}
      {report && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TotalCard label="Total Cost" value={`\u00A3${report.totals.totalCost.toFixed(2)}`} />
          <TotalCard label="Service" value={`\u00A3${report.totals.serviceCost.toFixed(2)}`} />
          <TotalCard label="Fuel" value={`\u00A3${report.totals.fuelCost.toFixed(2)}`} />
          <TotalCard label="Vehicles" value={String(report.totals.vehicleCount)} />
        </div>
      )}

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading cost data...</div>}
      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error instanceof Error ? error.message : 'Failed to load'}</div>}

      {/* Data table */}
      {sorted.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <Th label="Reg" field="reg" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Vehicle</th>
                <Th label="Service" field="serviceCost" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <Th label="Fuel" field="fuelCost" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <Th label="Total" field="totalCost" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(row => (
                <tr key={row.vehicleId} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link to={vmPath(`/vehicles/${row.vehicleId}`)} className="font-mono text-sm font-bold text-ooosh-navy hover:underline">
                      {row.reg}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{row.simpleType} {row.make}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.serviceCost > 0 ? `\u00A3${row.serviceCost.toFixed(2)}` : '—'}
                    {row.serviceCount > 0 && <span className="ml-1 text-[10px] text-gray-400">({row.serviceCount})</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.fuelCost > 0 ? `\u00A3${row.fuelCost.toFixed(2)}` : '—'}
                    {row.fuelCount > 0 && <span className="ml-1 text-[10px] text-gray-400">({row.fuelCount})</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {'\u00A3'}{row.totalCost.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TotalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-[10px] font-medium text-gray-400">{label}</p>
    </div>
  )
}

function Th({ label, field, sortBy, sortDir, onClick, align = 'left' }: {
  label: string; field: string; sortBy: string; sortDir: string
  onClick: (f: any) => void; align?: 'left' | 'right'
}) {
  return (
    <th
      className={`px-3 py-2 text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onClick(field)}
    >
      {label}
      {sortBy === field && <span className="ml-0.5 text-[9px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
    </th>
  )
}
