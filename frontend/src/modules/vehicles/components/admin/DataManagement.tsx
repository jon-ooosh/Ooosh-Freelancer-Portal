/**
 * Data Management — admin UI for bulk import/wipe operations.
 *
 * Wipe: Dry-run first, then confirm to delete R2 data by prefix.
 * Import: Upload CSV from Monday.com board, preview rows, then import.
 *
 * Hidden behind Settings > Data tab. Both operations require session auth.
 */

import { useState, useRef } from 'react'
import { apiFetch } from '../../config/api-config'
import { useAuth } from '../../hooks/useAuth'

interface WipeResult {
  dryRun: boolean
  totalDeleted: number
  byPrefix: Record<string, number>
}

interface ImportResult {
  saved: number
  failed: number
  total: number
}

interface ParsedRow {
  vehicleReg: string
  date: string
  preparedBy: string
  mileage: number | null
  fuelLevel: string | null
  overallStatus: string
  raw: Record<string, string>
}

/** Parse a CSV string into rows of key-value pairs */
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []

  // Parse header — handle quoted fields
  const parseRow = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    result.push(current.trim())
    return result
  }

  const headers = parseRow(lines[0]!)
  return lines.slice(1).map(line => {
    const values = parseRow(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = values[i] || ''
    })
    return row
  })
}

export function DataManagement() {
  const { sessionToken } = useAuth()

  // Wipe state
  const [wipeResult, setWipeResult] = useState<WipeResult | null>(null)
  const [isWiping, setIsWiping] = useState(false)
  const [wipeError, setWipeError] = useState<string | null>(null)
  const [wipeConfirmed, setWipeConfirmed] = useState(false)

  // Import state
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([])
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [columnMap, setColumnMap] = useState<{
    vehicleReg: string
    date: string
    preparedBy: string
    mileage: string
    fuelLevel: string
    overallStatus: string
  }>({
    vehicleReg: '',
    date: '',
    preparedBy: '',
    mileage: '',
    fuelLevel: '',
    overallStatus: '',
  })
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`,
  }

  // ── Wipe ──

  const WIPE_PREFIXES = ['events/', 'vehicle-events/', 'issues/', 'allocations/', 'collections/', 'prep/']

  const handleDryRun = async () => {
    setIsWiping(true)
    setWipeError(null)
    setWipeResult(null)
    setWipeConfirmed(false)
    try {
      const res = await apiFetch('/wipe-test-data', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prefixes: WIPE_PREFIXES, dryRun: true }),
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json() as WipeResult
      setWipeResult(data)
    } catch (err) {
      setWipeError(err instanceof Error ? err.message : 'Dry run failed')
    } finally {
      setIsWiping(false)
    }
  }

  const handleWipeForReal = async () => {
    setIsWiping(true)
    setWipeError(null)
    try {
      const res = await apiFetch('/wipe-test-data', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prefixes: WIPE_PREFIXES, dryRun: false }),
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json() as WipeResult
      setWipeResult(data)
      setWipeConfirmed(false)
    } catch (err) {
      setWipeError(err instanceof Error ? err.message : 'Wipe failed')
    } finally {
      setIsWiping(false)
    }
  }

  // ── Import ──

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImportResult(null)
    setImportError(null)

    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      const rows = parseCSV(text)
      setCsvRows(rows)

      // Auto-detect columns by common names
      if (rows.length > 0) {
        const headers = Object.keys(rows[0]!)
        const find = (keywords: string[]) =>
          headers.find(h => keywords.some(k => h.toLowerCase().includes(k))) || ''

        setColumnMap({
          vehicleReg: find(['reg', 'registration', 'vehicle']),
          date: find(['date', 'completed', 'created']),
          preparedBy: find(['prepared', 'technician', 'name', 'staff', 'by']),
          mileage: find(['mileage', 'odometer', 'miles']),
          fuelLevel: find(['fuel']),
          overallStatus: find(['status', 'result', 'overall']),
        })
      }
    }
    reader.readAsText(file)
  }

  const handleMapColumns = () => {
    const mapped = csvRows.map(row => ({
      vehicleReg: normalizeReg(row[columnMap.vehicleReg] || ''),
      date: normalizeDate(row[columnMap.date] || ''),
      preparedBy: row[columnMap.preparedBy] || 'Unknown',
      mileage: columnMap.mileage ? parseFloat(row[columnMap.mileage] || '') || null : null,
      fuelLevel: columnMap.fuelLevel ? row[columnMap.fuelLevel] || null : null,
      overallStatus: row[columnMap.overallStatus] || 'Completed',
      raw: row,
    })).filter(r => r.vehicleReg && r.date)

    setParsedRows(mapped)
  }

  const handleImport = async () => {
    setIsImporting(true)
    setImportError(null)

    const sessions = parsedRows.map(r => ({
      vehicleReg: r.vehicleReg,
      date: r.date,
      preparedBy: r.preparedBy,
      mileage: r.mileage,
      fuelLevel: r.fuelLevel,
      overallStatus: r.overallStatus,
      sections: [],  // Historical imports don't have detailed sections
    }))

    // Batch in groups of 100
    let totalSaved = 0
    let totalFailed = 0
    const batchSize = 100

    try {
      for (let i = 0; i < sessions.length; i += batchSize) {
        const batch = sessions.slice(i, i + batchSize)
        const res = await apiFetch('/import-prep-history', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ sessions: batch }),
        })
        if (!res.ok) throw new Error(`Server error: ${res.status}`)
        const data = await res.json() as ImportResult
        totalSaved += data.saved
        totalFailed += data.failed
      }

      setImportResult({ saved: totalSaved, failed: totalFailed, total: sessions.length })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setIsImporting(false)
    }
  }

  const resetImport = () => {
    setCsvRows([])
    setParsedRows([])
    setImportResult(null)
    setImportError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="space-y-6">
      {/* ── Prep History Import ── */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-1 font-medium">Import Prep History</h3>
        <p className="mb-3 text-xs text-gray-500">
          Upload a CSV export from Monday.com (or any spreadsheet). Map columns, preview, then import.
        </p>

        {/* Step 1: File upload */}
        {csvRows.length === 0 && !importResult && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFileSelect}
              className="hidden"
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm font-medium text-gray-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Select CSV file
            </label>
          </div>
        )}

        {/* Step 2: Column mapping */}
        {csvRows.length > 0 && parsedRows.length === 0 && !importResult && (
          <div className="space-y-3">
            <div className="rounded-lg bg-blue-50 p-2 text-xs text-blue-700">
              Found {csvRows.length} rows with {Object.keys(csvRows[0]!).length} columns.
              Map the columns below, then click Preview.
            </div>

            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(columnMap) as Array<keyof typeof columnMap>).map(field => (
                <div key={field}>
                  <label className="block text-xs font-medium text-gray-500 mb-0.5">
                    {field === 'vehicleReg' ? 'Vehicle Reg *' :
                     field === 'date' ? 'Date *' :
                     field === 'preparedBy' ? 'Prepared By' :
                     field === 'mileage' ? 'Mileage' :
                     field === 'fuelLevel' ? 'Fuel Level' :
                     'Overall Status'}
                  </label>
                  <select
                    value={columnMap[field]}
                    onChange={e => setColumnMap(prev => ({ ...prev, [field]: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    <option value="">— skip —</option>
                    {Object.keys(csvRows[0]!).map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleMapColumns}
                disabled={!columnMap.vehicleReg || !columnMap.date}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                Preview
              </button>
              <button
                onClick={resetImport}
                className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Preview + confirm */}
        {parsedRows.length > 0 && !importResult && (
          <div className="space-y-3">
            <div className="rounded-lg bg-green-50 p-2 text-xs text-green-700">
              {parsedRows.length} valid rows ready to import
              {csvRows.length - parsedRows.length > 0 && (
                <> ({csvRows.length - parsedRows.length} skipped — missing reg or date)</>
              )}
            </div>

            {/* Preview table */}
            <div className="max-h-48 overflow-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium text-gray-500">Reg</th>
                    <th className="px-2 py-1 text-left font-medium text-gray-500">Date</th>
                    <th className="px-2 py-1 text-left font-medium text-gray-500">By</th>
                    <th className="px-2 py-1 text-left font-medium text-gray-500">Miles</th>
                    <th className="px-2 py-1 text-left font-medium text-gray-500">Fuel</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 20).map((r, i) => (
                    <tr key={i} className="border-t border-gray-50">
                      <td className="px-2 py-1 font-mono">{r.vehicleReg}</td>
                      <td className="px-2 py-1">{r.date}</td>
                      <td className="px-2 py-1">{r.preparedBy}</td>
                      <td className="px-2 py-1">{r.mileage?.toLocaleString() ?? '—'}</td>
                      <td className="px-2 py-1">{r.fuelLevel ?? '—'}</td>
                    </tr>
                  ))}
                  {parsedRows.length > 20 && (
                    <tr><td colSpan={5} className="px-2 py-1 text-gray-400">...and {parsedRows.length - 20} more</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleImport}
                disabled={isImporting}
                className="rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                {isImporting ? `Importing... (${parsedRows.length} rows)` : `Import ${parsedRows.length} sessions`}
              </button>
              <button
                onClick={() => setParsedRows([])}
                disabled={isImporting}
                className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
              >
                Back
              </button>
              <button
                onClick={resetImport}
                disabled={isImporting}
                className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
              >
                Cancel
              </button>
            </div>

            {importError && (
              <div className="rounded-lg bg-red-50 p-2 text-xs text-red-600">{importError}</div>
            )}
          </div>
        )}

        {/* Step 4: Result */}
        {importResult && (
          <div className="space-y-2">
            <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
              Imported {importResult.saved} of {importResult.total} sessions
              {importResult.failed > 0 && (
                <span className="text-red-600"> ({importResult.failed} failed)</span>
              )}
            </div>
            <button
              onClick={resetImport}
              className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* ── Data Wipe ── */}
      <div className="rounded-lg border border-red-100 bg-white p-4">
        <h3 className="mb-1 font-medium text-red-700">Wipe Test Data</h3>
        <p className="mb-3 text-xs text-gray-500">
          Delete all data from R2 storage (events, issues, preps, allocations, collections).
          HireHop cache and stock inventory are protected.
        </p>

        {!wipeResult && (
          <button
            onClick={handleDryRun}
            disabled={isWiping}
            className="rounded-lg border border-red-200 px-4 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40"
          >
            {isWiping ? 'Scanning...' : 'Scan (dry run)'}
          </button>
        )}

        {wipeResult && wipeResult.dryRun && (
          <div className="space-y-2">
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
              <p className="font-medium mb-1">Dry run — {wipeResult.totalDeleted} objects would be deleted:</p>
              <ul className="space-y-0.5">
                {Object.entries(wipeResult.byPrefix).map(([prefix, count]) => (
                  <li key={prefix}>{prefix} — {count} objects</li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-red-600">
                <input
                  type="checkbox"
                  checked={wipeConfirmed}
                  onChange={e => setWipeConfirmed(e.target.checked)}
                />
                I understand this cannot be undone
              </label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleWipeForReal}
                disabled={!wipeConfirmed || isWiping}
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                {isWiping ? 'Wiping...' : `Delete ${wipeResult.totalDeleted} objects`}
              </button>
              <button
                onClick={() => { setWipeResult(null); setWipeConfirmed(false) }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {wipeResult && !wipeResult.dryRun && (
          <div className="space-y-2">
            <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
              Done — deleted {wipeResult.totalDeleted} objects
            </div>
            <button
              onClick={() => setWipeResult(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600"
            >
              OK
            </button>
          </div>
        )}

        {wipeError && (
          <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-600">{wipeError}</div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──

/** Normalize registration: uppercase, remove spaces */
function normalizeReg(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

/** Normalize date to YYYY-MM-DD. Handles DD/MM/YYYY, MM/DD/YYYY, and ISO formats. */
function normalizeDate(raw: string): string {
  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  // DD/MM/YYYY (UK format — assume this since it's a UK business)
  const ukMatch = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/)
  if (ukMatch) {
    const [, day, month, year] = ukMatch
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
  }

  // Try Date.parse as fallback
  const d = new Date(raw)
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10)
  }

  return ''
}
