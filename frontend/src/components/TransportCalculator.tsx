import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import { TimeInput, normalizeTimeInput } from './TimeInput';
import type { QuoteJobType, QuoteCalcMode, QuoteWhatIsIt, QuoteExpenseItem } from '@shared/index';
// Canonical calculation engine — shared with the backend save / HireHop-push path.
// What the modal shows below is exactly what gets saved and pushed (no second engine).
import { calculateCosts, applyCrewMultiplier } from '@calc';
import type { CalculatorInput, CalculatedCosts, CalculatorSettings, ExpenseItem } from '@calc';

// =============================================================================
// TYPES
// =============================================================================

interface VenueOption {
  id: string;
  name: string;
  address?: string | null;
  default_miles_from_base?: number | null;
  default_drive_time_mins?: number | null;
}

interface FormData {
  jobType: QuoteJobType | '';
  whatIsIt: QuoteWhatIsIt | '';
  calculationMode: QuoteCalcMode;
  jobDate: string;
  jobFinishDate: string;
  isMultiDay: boolean;
  arrivalTime: string;
  addCollection: boolean;
  collectionDate: string;
  collectionArrivalTime: string;
  destination: string;
  selectedVenueId: string | null;
  isNewVenue: boolean;
  distanceMiles: number;
  driveTimeMinutes: number;
  travelMethod: 'public_transport' | 'own_way' | '';
  travelTimeMins: number;
  travelCost: number;
  workType: string;
  workTypeOther: string;
  workDurationHours: number;
  workDescription: string;
  crewCount: number;
  numberOfDays: number;
  earlyStartMinutes: number;
  lateFinishMinutes: number;
  dayRateOverride: number | null;
  clientDayRateOverride: number | null;
  applyMinHours: boolean;
  includesSetupWork: boolean;
  setupWorkDescription: string;
  setupExtraTimeHours: number;
  setupFixedPremium: number;
  oohManualOverride: boolean;
  expenses: QuoteExpenseItem[];
  internalNotes: string;
  freelancerNotes: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatDateUK(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime12h(time: string): string {
  if (!time) return '';
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${minutes}${ampm}`;
}

function formatMinutesAsTime(mins: number): string {
  if (mins < 0) mins += 1440;
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
}

function formatDurationHM(minutes: number): string {
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Extract YYYY-MM-DD from ISO date string or date string */
function toDateInput(dateStr?: string | null): string {
  if (!dateStr) return '';
  // Handle ISO format "2026-03-15T00:00:00.000Z" or plain "2026-03-15"
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function generateExpenseId(): string {
  return `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateDaysBetween(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 1;
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 1;
  const diffTime = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
}

// =============================================================================
// CALCULATOR INPUT BUILDER
// =============================================================================
//
// Maps the modal's form state to the canonical engine's CalculatorInput. This is
// the ONE place form fields become calculator inputs — both the live display
// (calculateCosts below) and the save payload (handleSave) derive from it, so the
// number shown is exactly the number saved and pushed to HireHop.
//
// Note: leg modelling (round-trip vs one-way) is the engine's job and is driven by
// `travelMethod` — 'own_way'/blank collapse to 'vehicle' (van both ways), matching
// the backend exactly.

function buildCalculatorInput(fd: FormData): CalculatorInput {
  // Normalise arrival time identically to the save path (default 09:00).
  let arrivalTime = fd.arrivalTime || '09:00';
  if (!/^\d{2}:\d{2}$/.test(arrivalTime)) {
    arrivalTime = normalizeTimeInput(arrivalTime) || '09:00';
  }

  // Same expense filtering + shaping the save uses. The engine ignores the fuel
  // line's amount (it derives fuel from distance), so its value here is irrelevant.
  const expenses: ExpenseItem[] = fd.expenses
    .filter(e => e.category === 'fuel' || e.amount > 0 || (e.category === 'pd' && !!e.pdDays && e.amount > 0))
    .map(e => ({
      type: e.category,
      description: e.label + (e.description ? `: ${e.description}` : ''),
      amount: e.category === 'pd' && e.pdDays ? e.amount * e.pdDays : e.amount,
      includedInCharge: e.included,
      chargeMode: e.chargeMode ?? (e.included ? 'included' : 'not_included'),
    }));

  // Setup time/premium only count when the "includes setup work" box is ticked.
  const setupExtraHrs = fd.includesSetupWork ? Number(fd.setupExtraTimeHours) || 0 : 0;
  const setupPremium = fd.includesSetupWork ? Number(fd.setupFixedPremium) || 0 : 0;

  return {
    jobType: (fd.jobType || 'delivery') as QuoteJobType,
    calculationMode: fd.calculationMode === 'hourly' ? 'hourly' : 'dayrate',
    distanceMiles: Number(fd.distanceMiles) || 0,
    driveTimeMins: Number(fd.driveTimeMinutes) || 0,
    arrivalTime,
    workDurationHrs: Number(fd.workDurationHours) || 0,
    numDays: Math.max(1, Number(fd.numberOfDays) || 1),
    setupExtraHrs,
    setupPremium,
    travelMethod: fd.travelMethod === 'public_transport' ? 'public_transport' : 'vehicle',
    travelTimeMins: Number(fd.travelTimeMins) || 0,
    travelCost: Number(fd.travelCost) || 0,
    dayRateOverride: fd.dayRateOverride != null ? Number(fd.dayRateOverride) : undefined,
    clientRateOverride: fd.clientDayRateOverride != null ? Number(fd.clientDayRateOverride) : undefined,
    applyMinHours: fd.applyMinHours,
    oohOverride: fd.oohManualOverride
      ? { earlyStartMins: Number(fd.earlyStartMinutes) || 0, lateFinishMins: Number(fd.lateFinishMinutes) || 0 }
      : null,
    expenses,
  };
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const createInitialExpenses = (): QuoteExpenseItem[] => [
  { id: generateExpenseId(), category: 'fuel', label: 'Fuel', amount: 0, included: true },
  { id: generateExpenseId(), category: 'parking', label: 'Parking', amount: 0, included: false },
  { id: generateExpenseId(), category: 'tolls', label: 'Tolls / Crossings', amount: 0, included: false },
  { id: generateExpenseId(), category: 'transport_out', label: 'Transport (outbound)', amount: 0, included: false },
  { id: generateExpenseId(), category: 'transport_back', label: 'Transport (return)', amount: 0, included: false },
  { id: generateExpenseId(), category: 'hotel', label: 'Hotel', amount: 0, included: false },
  { id: generateExpenseId(), category: 'pd', label: 'Per Diem (PD)', amount: 0, included: false, pdDays: 1 },
];

const INITIAL_FORM: FormData = {
  jobType: '',
  whatIsIt: '',
  calculationMode: 'hourly',
  jobDate: '',
  jobFinishDate: '',
  isMultiDay: false,
  arrivalTime: '',
  addCollection: false,
  collectionDate: '',
  collectionArrivalTime: '',
  destination: '',
  selectedVenueId: null,
  isNewVenue: false,
  distanceMiles: 0,
  driveTimeMinutes: 0,
  travelMethod: '',
  travelTimeMins: 0,
  travelCost: 0,
  workType: '',
  workTypeOther: '',
  workDurationHours: 0,
  workDescription: '',
  crewCount: 1,
  numberOfDays: 1,
  earlyStartMinutes: 0,
  lateFinishMinutes: 0,
  dayRateOverride: null,
  clientDayRateOverride: null,
  applyMinHours: true,
  includesSetupWork: false,
  setupWorkDescription: '',
  setupExtraTimeHours: 0,
  setupFixedPremium: 0,
  oohManualOverride: false,
  expenses: createInitialExpenses(),
  internalNotes: '',
  freelancerNotes: '',
};

const WORK_TYPE_OPTIONS = [
  { value: 'backline_tech', label: 'Backline Tech' },
  { value: 'general_assist', label: 'General Assist' },
  { value: 'engineer_foh', label: 'Engineer - FOH' },
  { value: 'engineer_mons', label: 'Engineer - mons' },
  { value: 'driving_only', label: 'Driving Only' },
  { value: 'other', label: 'Other' },
];

// =============================================================================
// PROPS
// =============================================================================

interface TransportCalculatorProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
  jobId?: string;          // Pre-fill from job context
  jobName?: string;
  clientName?: string;
  venueName?: string;
  venueId?: string;
  jobDate?: string;
  jobEndDate?: string;
  hhJobNumber?: number;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function TransportCalculator({
  isOpen, onClose, onSaved,
  jobId, jobName, clientName, venueName, venueId, jobDate, jobEndDate, hhJobNumber,
}: TransportCalculatorProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [settings, setSettings] = useState<CalculatorSettings | null>(null);
  const [formData, setFormData] = useState<FormData>(INITIAL_FORM);
  const [venues, setVenues] = useState<VenueOption[]>([]);
  const [venueSearch, setVenueSearch] = useState('');
  const [venueDropdownOpen, setVenueDropdownOpen] = useState(false);
  const [step, setStep] = useState(1);
  const venueDropdownRef = useRef<HTMLDivElement>(null);
  // Track original HireHop dates for change warnings
  const [hhOriginalDate, setHhOriginalDate] = useState('');
  const [hhOriginalEndDate, setHhOriginalEndDate] = useState('');
  // Track original venue transport values for writeback
  const [venueOriginalMiles, setVenueOriginalMiles] = useState<number | null>(null);
  const [venueOriginalDriveTime, setVenueOriginalDriveTime] = useState<number | null>(null);
  const [creatingVenue, setCreatingVenue] = useState(false);
  // Quick-add venue form (captures address + travel defaults inline so a
  // freshly-created venue feeds the calc and doesn't need editing later).
  const [showVenueForm, setShowVenueForm] = useState(false);
  const [nvName, setNvName] = useState('');
  const [nvAddress, setNvAddress] = useState('');
  const [nvCity, setNvCity] = useState('');
  const [nvPostcode, setNvPostcode] = useState('');
  const [nvMiles, setNvMiles] = useState('');
  const [nvDriveTime, setNvDriveTime] = useState('');
  const [nvTolls, setNvTolls] = useState('');

  // Load settings + venues on open
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setStep(1);
    setShowVenueForm(false);

    // Parse dates from HireHop props
    const parsedDate = toDateInput(jobDate);
    const parsedEndDate = toDateInput(jobEndDate);
    setHhOriginalDate(parsedDate);
    setHhOriginalEndDate(parsedEndDate);

    // Reset form with pre-filled values
    setFormData({
      ...INITIAL_FORM,
      expenses: createInitialExpenses(),
      jobDate: parsedDate,
      jobFinishDate: parsedEndDate,
      isMultiDay: false,
      collectionDate: parsedEndDate || parsedDate, // Pre-fill collection date from HireHop end date (or start)
    });
    setVenueSearch(venueName || '');

    Promise.all([loadSettings(), loadVenues()]).then(() => setLoading(false));
  }, [isOpen]);

  // Pre-fill venue if provided
  useEffect(() => {
    if (venueId && venues.length > 0) {
      const v = venues.find(v => v.id === venueId);
      if (v) handleVenueSelect(v);
    }
  }, [venueId, venues]);

  // Close venue dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (venueDropdownRef.current && !venueDropdownRef.current.contains(e.target as Node)) {
        setVenueDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Auto-calculate number of days for multi-day
  useEffect(() => {
    if (formData.isMultiDay && formData.jobDate && formData.jobFinishDate) {
      const days = calculateDaysBetween(formData.jobDate, formData.jobFinishDate);
      if (days !== formData.numberOfDays) setFormData(prev => ({ ...prev, numberOfDays: days }));
    }
  }, [formData.isMultiDay, formData.jobDate, formData.jobFinishDate]);

  async function loadSettings() {
    try {
      const data = await api.get<{ data: Record<string, { value: number }> }>('/quotes/settings');
      const s: Record<string, number> = {};
      for (const [key, info] of Object.entries(data.data)) s[key] = info.value;
      setSettings({
        freelancer_hourly_day: s.freelancer_hourly_day ?? 18,
        freelancer_hourly_night: s.freelancer_hourly_night ?? 25,
        client_hourly_day: s.client_hourly_day ?? 33,
        client_hourly_night: s.client_hourly_night ?? 45,
        driver_day_rate: s.driver_day_rate ?? 180,
        admin_cost_per_hour: s.admin_cost_per_hour ?? 5,
        fuel_price_per_litre: s.fuel_price_per_litre ?? 1.45,
        handover_time_mins: s.handover_time_mins ?? 15,
        unload_time_mins: s.unload_time_mins ?? 30,
        expense_markup_percent: s.expense_markup_percent ?? 10,
        min_hours_threshold: s.min_hours_threshold ?? 5,
        min_client_charge_floor: s.min_client_charge_floor ?? 0,
        day_rate_client_markup: s.day_rate_client_markup ?? 1.8,
        fuel_efficiency_mpg: s.fuel_efficiency_mpg ?? 5,
        expense_variance_threshold: s.expense_variance_threshold ?? 20,
      });
    } catch {
      setError('Failed to load calculator settings');
    }
  }

  async function loadVenues() {
    try {
      const data = await api.get<{ data: VenueOption[] }>('/venues?limit=500');
      setVenues(data.data);
    } catch {
      console.error('Failed to load venues');
    }
  }

  // Display costs come straight from the canonical engine, fed the exact same
  // input the save sends — so the figures below === the saved + pushed figures.
  const crewMultiplier = formData.jobType === 'crewed' && formData.crewCount > 1 ? formData.crewCount : 1;
  const costs: CalculatedCosts | null = settings && formData.jobType
    ? applyCrewMultiplier(calculateCosts(buildCalculatorInput(formData), settings), crewMultiplier)
    : null;

  const updateField = useCallback(<K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  }, []);

  function handleVenueSelect(venue: VenueOption) {
    setVenueSearch(venue.name);
    setVenueDropdownOpen(false);
    // Store originals for writeback comparison
    setVenueOriginalMiles(venue.default_miles_from_base ?? null);
    setVenueOriginalDriveTime(venue.default_drive_time_mins ?? null);
    setFormData(prev => ({
      ...prev,
      destination: venue.name,
      selectedVenueId: venue.id,
      isNewVenue: false,
      distanceMiles: venue.default_miles_from_base ?? 0,
      driveTimeMinutes: venue.default_drive_time_mins ?? 0,
      expenses: prev.expenses.map(exp =>
        exp.category === 'fuel' ? { ...exp, included: true } : exp
      ),
    }));
  }

  function handleVenueInput(text: string) {
    setVenueSearch(text);
    setVenueDropdownOpen(true);
    setFormData(prev => ({
      ...prev,
      destination: text,
      selectedVenueId: null,
      isNewVenue: text.length > 0 && !venues.some(v => v.name.toLowerCase() === text.toLowerCase()),
    }));
  }

  const updateExpense = useCallback((updated: QuoteExpenseItem) => {
    setFormData(prev => ({ ...prev, expenses: prev.expenses.map(exp => exp.id === updated.id ? updated : exp) }));
  }, []);

  // Bulk-set every expense line to one charge mode (the "set all" column heads).
  const setAllChargeMode = useCallback((mode: 'included' | 'not_included' | 'recharge') => {
    setFormData(prev => ({
      ...prev,
      expenses: prev.expenses.map(exp => ({ ...exp, chargeMode: mode, included: mode === 'included' })),
    }));
  }, []);

  const addOtherExpense = useCallback(() => {
    setFormData(prev => ({
      ...prev,
      expenses: [...prev.expenses, { id: generateExpenseId(), category: 'other', label: 'Other', amount: 0, included: true, description: '' }],
    }));
  }, []);

  const removeExpense = useCallback((id: string) => {
    setFormData(prev => ({ ...prev, expenses: prev.expenses.filter(exp => exp.id !== id) }));
  }, []);

  // Open the inline quick-add form, seeding the name from what was typed.
  function openVenueForm() {
    setNvName(venueSearch.trim());
    setNvAddress('');
    setNvCity('');
    setNvPostcode('');
    setNvMiles('');
    setNvDriveTime('');
    setNvTolls('');
    setShowVenueForm(true);
    setVenueDropdownOpen(false);
  }

  async function handleCreateVenue() {
    const name = nvName.trim() || venueSearch.trim();
    if (!name) return;
    setCreatingVenue(true);
    try {
      const miles = nvMiles.trim() ? parseFloat(nvMiles) : null;
      const driveTime = nvDriveTime.trim() ? parseInt(nvDriveTime, 10) : null;
      const tolls = nvTolls.trim() ? parseFloat(nvTolls) : null;
      const newVenue = await api.post<{ id: string; name: string }>('/venues', {
        name,
        address: nvAddress.trim() || null,
        city: nvCity.trim() || null,
        postcode: nvPostcode.trim() || null,
        default_miles_from_base: miles !== null && !isNaN(miles) ? miles : null,
        default_drive_time_mins: driveTime !== null && !isNaN(driveTime) ? driveTime : null,
        default_tolls_amount: tolls !== null && !isNaN(tolls) ? tolls : null,
      });
      const created: VenueOption = {
        id: newVenue.id,
        name: newVenue.name ?? name,
        address: nvAddress.trim() || null,
        default_miles_from_base: miles !== null && !isNaN(miles) ? miles : null,
        default_drive_time_mins: driveTime !== null && !isNaN(driveTime) ? driveTime : null,
      };
      setVenues(prev => [...prev, created]);
      setVenueSearch(created.name);
      setShowVenueForm(false);
      handleVenueSelect(created);
    } catch {
      setError('Failed to create venue');
    } finally {
      setCreatingVenue(false);
    }
  }

  async function handleSave() {
    if (!costs || !settings) return;
    setSaving(true);
    setError(null);

    try {
      // Build the canonical calculator input — the SAME object the display used —
      // so the backend recomputes (and HireHop receives) exactly what's on screen.
      const input = buildCalculatorInput(formData);
      // input.arrivalTime carries the 09:00 costing default (the OOH split needs a
      // time). The STORED arrival time is the user's ACTUAL entry — leave it blank
      // when none was given so the quote shows "Time TBC" and pushes no time to
      // HireHop, instead of a fabricated 09:00.
      const enteredArrival = formData.arrivalTime.trim()
        ? (/^\d{2}:\d{2}$/.test(formData.arrivalTime.trim())
            ? formData.arrivalTime.trim()
            : (normalizeTimeInput(formData.arrivalTime) || null))
        : null;

      // Payload expenses come from the engine input; only the fuel line's display
      // amount is swapped to the engine-derived figure (engine ignores it for calc).
      const expensesToSend = input.expenses.map(e =>
        e.type === 'fuel' ? { ...e, amount: Number(costs.expectedFuelCost) || 0 } : e,
      );

      const saveResult = await api.post<{ id: string }>('/quotes', {
        jobId: jobId || null,
        jobType: input.jobType,
        calculationMode: input.calculationMode,
        distanceMiles: input.distanceMiles,
        driveTimeMins: input.driveTimeMins,
        arrivalTime: enteredArrival,
        workDurationHrs: input.workDurationHrs,
        numDays: input.numDays,
        setupExtraHrs: input.setupExtraHrs,
        setupPremium: input.setupPremium,
        travelMethod: input.travelMethod,
        dayRateOverride: input.dayRateOverride ?? null,
        clientRateOverride: input.clientRateOverride ?? null,
        applyMinHours: input.applyMinHours ?? null,
        expenses: expensesToSend,
        venueId: formData.selectedVenueId || null,
        venueName: formData.destination || null,
        jobDate: formData.jobDate || null,
        jobFinishDate: formData.jobFinishDate || null,
        isMultiDay: formData.isMultiDay,
        whatIsIt: formData.whatIsIt || null,
        addCollection: formData.addCollection,
        collectionDate: formData.collectionDate || null,
        collectionTime: formData.collectionArrivalTime || input.arrivalTime,
        clientName: clientName || null,
        includesSetup: formData.includesSetupWork,
        setupDescription: formData.setupWorkDescription || null,
        workType: formData.workType || null,
        workDescription: formData.workDescription || null,
        oohManual: formData.oohManualOverride,
        earlyStartMins: input.oohOverride ? input.oohOverride.earlyStartMins : costs.autoEarlyStartMinutes,
        lateFinishMins: input.oohOverride ? input.oohOverride.lateFinishMins : costs.autoLateFinishMinutes,
        travelTimeMins: input.travelTimeMins || null,
        travelCost: input.travelCost || null,
        internalNotes: formData.internalNotes || null,
        freelancerNotes: formData.freelancerNotes || null,
        crewCount: formData.crewCount > 1 ? formData.crewCount : 1,
      });

      // Write back venue distance/drive time if changed or newly filled
      if (formData.selectedVenueId && formData.distanceMiles > 0) {
        const milesChanged = venueOriginalMiles !== formData.distanceMiles;
        const timeChanged = venueOriginalDriveTime !== formData.driveTimeMinutes;
        if (milesChanged || timeChanged) {
          try {
            await api.put(`/venues/${formData.selectedVenueId}`, {
              default_miles_from_base: formData.distanceMiles,
              default_drive_time_mins: Math.round(formData.driveTimeMinutes),
            });
          } catch {
            // Non-critical — don't block the save
            console.warn('Failed to update venue transport defaults');
          }
        }
      }

      // Auto-push to HireHop if job has an HH number.
      // Paired delivery+collection quotes get pushed as two separate line items.
      const pairedId = (saveResult as { paired_id?: string | null } | null)?.paired_id || null;
      if (saveResult?.id && hhJobNumber) {
        try {
          await api.post(`/quotes/${saveResult.id}/push-hirehop`, {});
          if (pairedId) {
            await api.post(`/quotes/${pairedId}/push-hirehop`, {});
            setSuccess('Quotes saved + pushed to HireHop (delivery + collection)');
          } else {
            setSuccess('Quote saved + pushed to HireHop');
          }
        } catch (hhErr) {
          console.warn('HireHop push failed (quote saved OK):', hhErr);
          setSuccess('Quote saved (HireHop push failed — push manually later)');
        }
      } else {
        setSuccess(pairedId ? 'Quotes saved (delivery + collection)' : 'Quote saved successfully');
      }
      onSaved?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save quote';
      setError(msg);
      console.error('Quote save failed:', msg, err);
    } finally {
      setSaving(false);
    }
  }

  // ESC to close
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isCrewedJob = formData.jobType === 'crewed';
  const isDC = formData.jobType === 'delivery' || formData.jobType === 'collection';
  const isVehicle = formData.whatIsIt === 'vehicle';
  const needsTravelQuestion = isDC && isVehicle;
  const totalSteps = isCrewedJob ? 5 : 4;
  const stepLabels = isCrewedJob ? ['🎯 Job', '🚗 Transport', '🔧 Work', '💷 Expenses', '📋 Review'] : ['🎯 Job', '🚗 Transport', '💷 Expenses', '📋 Review'];

  const isStep1Valid = formData.jobType !== '' && formData.jobDate !== '' && (isCrewedJob || formData.whatIsIt !== '');
  const isStep2Valid = isCrewedJob ? true : (formData.destination !== '' && formData.distanceMiles >= 0);
  const isStep3Valid = !isCrewedJob || (formData.workType !== '' && (formData.workType !== 'other' || formData.workTypeOther.trim() !== ''));

  const filteredVenues = venues.filter(v => v.name.toLowerCase().includes(venueSearch.toLowerCase())).slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50">
      <div className="bg-gray-50 w-full max-w-4xl min-h-screen sm:min-h-0 sm:my-8 sm:rounded-xl sm:shadow-xl">
        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sm:rounded-t-xl">
          <div>
            <h2 className="text-lg font-bold text-gray-900">🧮 Transport & Crew Calculator</h2>
            {(jobName || hhJobNumber) && (
              <p className="text-sm text-gray-500">
                {hhJobNumber ? `#${hhJobNumber} ` : ''}{jobName || ''}{clientName ? ` — ${clientName}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-2">&times;</button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-ooosh-600" />
          </div>
        ) : (
          <div className="p-6">
            {/* Step indicator */}
            <div className="flex items-center justify-between mb-6">
              {stepLabels.map((label, idx) => (
                <div key={label} className="flex items-center">
                  <button
                    onClick={() => { if (idx + 1 < step) setStep(idx + 1); }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                      step > idx + 1 ? 'bg-green-500 text-white cursor-pointer' :
                      step === idx + 1 ? 'bg-ooosh-600 text-white' :
                      'bg-gray-200 text-gray-600'
                    }`}
                  >
                    {step > idx + 1 ? '\u2713' : idx + 1}
                  </button>
                  <span className={`ml-2 text-sm hidden sm:inline ${step === idx + 1 ? 'text-ooosh-600 font-medium' : 'text-gray-500'}`}>{label}</span>
                  {idx < totalSteps - 1 && <div className="w-4 sm:w-8 h-0.5 bg-gray-200 mx-2" />}
                </div>
              ))}
            </div>

            {error && <div className="mb-4 bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}
            {success && (
              <div className="mb-4 bg-green-50 text-green-700 px-4 py-3 rounded-lg text-sm">
                {success}
                <button onClick={onClose} className="ml-3 underline text-green-800 text-sm">Close</button>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm p-6">
              {/* ─── STEP 1: JOB DETAILS ─── */}
              {step === 1 && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-gray-900">🎯 What are we doing?</h3>

                  {/* Job type */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {([
                      { value: 'delivery', label: 'Delivery', desc: 'Taking something out', emoji: '📦' },
                      { value: 'collection', label: 'Collection', desc: 'Bringing something back', emoji: '📥' },
                      { value: 'crewed', label: 'Crewed Job', desc: 'Freelancer works on site', emoji: '👷' },
                    ] as const).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          jobType: opt.value,
                          addCollection: false,
                          whatIsIt: opt.value === 'crewed' ? '' : prev.whatIsIt,
                          calculationMode: opt.value === 'crewed' ? 'dayrate' : 'hourly',
                          includesSetupWork: false,
                          oohManualOverride: false,
                          // Collection uses end date as primary; delivery/crewed use start date
                          jobDate: opt.value === 'collection'
                            ? (hhOriginalEndDate || hhOriginalDate || prev.jobDate)
                            : (hhOriginalDate || prev.jobDate),
                        }))}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${formData.jobType === opt.value ? 'border-ooosh-500 bg-ooosh-50' : 'border-gray-200 hover:border-gray-300'}`}
                      >
                        <div className="text-2xl mb-1">{opt.emoji}</div>
                        <h4 className="font-semibold text-gray-900">{opt.label}</h4>
                        <p className="text-xs text-gray-500">{opt.desc}</p>
                      </button>
                    ))}
                  </div>

                  {/* What is it? (D&C only) */}
                  {isDC && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">🤔 What is it?</label>
                      <div className="grid grid-cols-3 gap-3">
                        {([
                          { value: 'vehicle', label: 'A Vehicle', hint: 'Driver returns separately', emoji: '🚐' },
                          { value: 'equipment', label: 'Equipment', hint: 'Driver returns with van', emoji: '🎸' },
                          { value: 'people', label: 'People', hint: 'Driver returns with van', emoji: '👥' },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => updateField('whatIsIt', opt.value)}
                            className={`p-3 rounded-lg border-2 text-center transition-all ${formData.whatIsIt === opt.value ? 'border-ooosh-500 bg-ooosh-50' : 'border-gray-200 hover:border-gray-300'}`}
                          >
                            <div className="text-xl mb-1">{opt.emoji}</div>
                            <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                            <p className="text-xs text-gray-500">{opt.hint}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Setup work toggle (D&C only) */}
                  {isDC && formData.whatIsIt && (
                    <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                      <label className="flex items-center space-x-2">
                        <input type="checkbox" checked={formData.includesSetupWork} onChange={(e) => updateField('includesSetupWork', e.target.checked)} className="w-4 h-4 text-ooosh-600 rounded" />
                        <span className="text-sm font-medium text-gray-700">
                          {formData.jobType === 'delivery' ? 'Includes setup work on site' : 'Includes pack-down work on site'}
                        </span>
                      </label>
                      {formData.includesSetupWork && (
                        <div className="ml-6 space-y-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                            <input type="text" value={formData.setupWorkDescription} onChange={(e) => updateField('setupWorkDescription', e.target.value)}
                              placeholder="e.g. Set up PA in main hall" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Extra time (hours)</label>
                              <input type="number" value={formData.setupExtraTimeHours || ''} onChange={(e) => updateField('setupExtraTimeHours', parseFloat(e.target.value) || 0)}
                                placeholder="0" min="0" step="0.5" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Fixed premium (&pound;)</label>
                              <input type="number" value={formData.setupFixedPremium || ''} onChange={(e) => updateField('setupFixedPremium', parseFloat(e.target.value) || 0)}
                                placeholder="0" min="0" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* When */}
                  <div className="border-t pt-6">
                    <h4 className="font-medium text-gray-900 mb-4">📅 When?</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {formData.isMultiDay ? 'Start Date' : (formData.jobType === 'collection' ? 'Collection Date' : 'Job Date')}
                        </label>
                        <input type="date" value={formData.jobDate} onChange={(e) => updateField('jobDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                        {(() => {
                          // Collection jobs compare against end date; delivery/crewed against start date
                          const hhRef = formData.jobType === 'collection' ? hhOriginalEndDate : hhOriginalDate;
                          return hhRef && formData.jobDate && formData.jobDate !== hhRef ? (
                            <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                              <span>⚠️</span> Changed from HireHop date: {formatDateUK(hhRef)}
                            </p>
                          ) : null;
                        })()}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Arrive by (optional)</label>
                        <TimeInput value={formData.arrivalTime} onChange={(v) => updateField('arrivalTime', v)} />
                      </div>
                      {(isCrewedJob || isDC) && (
                        <>
                          <div className="md:col-span-2">
                            <label className="flex items-center space-x-2">
                              <input type="checkbox" checked={formData.isMultiDay} onChange={(e) => { updateField('isMultiDay', e.target.checked); if (e.target.checked) updateField('calculationMode', 'dayrate'); }} className="w-4 h-4 text-ooosh-600 rounded" />
                              <span className="text-sm font-medium text-gray-700">Multi-day job</span>
                              {isDC && <span className="text-xs text-gray-500 ml-2">(switches pricing to day rate)</span>}
                            </label>
                          </div>
                          {formData.isMultiDay && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Finish Date</label>
                              <input type="date" value={formData.jobFinishDate} onChange={(e) => updateField('jobFinishDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                              {formData.jobDate && formData.jobFinishDate && (
                                <p className="text-xs text-ooosh-600 mt-1">{calculateDaysBetween(formData.jobDate, formData.jobFinishDate)} days</p>
                              )}
                              {hhOriginalEndDate && formData.jobFinishDate && formData.jobFinishDate !== hhOriginalEndDate && (
                                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                                  <span>⚠️</span> Changed from HireHop: {formatDateUK(hhOriginalEndDate)}
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                      {formData.jobType === 'delivery' && (
                        <>
                          <div className="md:col-span-2">
                            <label className="flex items-center space-x-2">
                              <input type="checkbox" checked={formData.addCollection} onChange={(e) => {
                                updateField('addCollection', e.target.checked);
                                if (e.target.checked && hhOriginalEndDate && !formData.collectionDate) {
                                  updateField('collectionDate', hhOriginalEndDate);
                                }
                              }} className="w-4 h-4 text-ooosh-600 rounded" />
                              <span className="text-sm font-medium text-gray-700">Add collection from same location</span>
                            </label>
                          </div>
                          {formData.addCollection && (
                            <>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Collection Date</label>
                                <input type="date" value={formData.collectionDate} onChange={(e) => updateField('collectionDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                                {hhOriginalEndDate && formData.collectionDate && formData.collectionDate !== hhOriginalEndDate && (
                                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                                    <span>⚠️</span> Changed from HireHop end date: {formatDateUK(hhOriginalEndDate)}
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Collection arrive by</label>
                                <TimeInput value={formData.collectionArrivalTime} onChange={(v) => updateField('collectionArrivalTime', v)} />
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── STEP 2: TRANSPORT ─── */}
              {step === 2 && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-gray-900">🚗 Transport Details</h3>

                  {/* Vehicle delivery/collection reminder */}
                  {isDC && isVehicle && (
                    <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 text-sm text-orange-800">
                      🚐 Vehicle {formData.jobType === 'delivery' ? 'delivery' : 'collection'}: Driver will need to {formData.jobType === 'delivery' ? 'get home' : 'get there'}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="md:col-span-2" ref={venueDropdownRef}>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Destination</label>
                      <div className="relative">
                        <input
                          type="text"
                          value={venueSearch}
                          onChange={(e) => handleVenueInput(e.target.value)}
                          onFocus={() => setVenueDropdownOpen(true)}
                          placeholder="Search venues..."
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-ooosh-500"
                        />
                        {venueDropdownOpen && venueSearch.length > 0 && (
                          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                            {filteredVenues.map(v => (
                              <button key={v.id} type="button" onClick={() => handleVenueSelect(v)}
                                className="w-full px-4 py-2 text-left hover:bg-gray-100 border-b border-gray-50">
                                <div className="flex justify-between items-center">
                                  <span className="font-medium text-gray-900 text-sm">{v.name}</span>
                                  {(v.default_miles_from_base || v.default_drive_time_mins) && (
                                    <span className="text-xs text-gray-500 ml-2">
                                      {v.default_miles_from_base ? `${v.default_miles_from_base}mi` : ''}{v.default_miles_from_base && v.default_drive_time_mins ? ' / ' : ''}{v.default_drive_time_mins ? `${v.default_drive_time_mins}min` : ''}
                                    </span>
                                  )}
                                </div>
                              </button>
                            ))}
                            {filteredVenues.length === 0 && (
                              <div className="px-4 py-2 text-gray-500 text-sm">No matching venues</div>
                            )}
                            {venueSearch.trim().length > 0 && !venues.some(v => v.name.toLowerCase() === venueSearch.trim().toLowerCase()) && (
                              <button
                                type="button"
                                onClick={openVenueForm}
                                className="w-full px-4 py-2 text-left hover:bg-ooosh-50 border-t border-gray-100 text-sm text-ooosh-600 font-medium"
                              >
                                {`➕ Create "${venueSearch.trim()}" as new venue`}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      {formData.selectedVenueId && (
                        <div className="mt-1">
                          <p className="text-xs text-green-600">✅ Selected from venues database</p>
                          {venueOriginalMiles === null && venueOriginalDriveTime === null && (
                            <p className="text-xs text-amber-600 mt-0.5">📍 No saved distance/time — fill in below and it'll be saved to the venue</p>
                          )}
                          {(venueOriginalMiles !== null || venueOriginalDriveTime !== null) &&
                           (formData.distanceMiles !== (venueOriginalMiles ?? 0) || formData.driveTimeMinutes !== (venueOriginalDriveTime ?? 0)) && (
                            <p className="text-xs text-amber-600 mt-0.5">📍 Changed from saved values — will update venue on save</p>
                          )}
                        </div>
                      )}

                      {showVenueForm && (
                        <div className="mt-3 border border-ooosh-200 bg-ooosh-50/50 rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-gray-900">New venue details</h4>
                            <button type="button" onClick={() => setShowVenueForm(false)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Venue name *</label>
                            <input type="text" value={nvName} onChange={(e) => setNvName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Address</label>
                            <textarea value={nvAddress} onChange={(e) => setNvAddress(e.target.value)} rows={2} placeholder="Street address" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">City / Town</label>
                              <input type="text" value={nvCity} onChange={(e) => setNvCity(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Postcode</label>
                              <input type="text" value={nvPostcode} onChange={(e) => setNvPostcode(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Miles (one-way)</label>
                              <input type="number" min="0" value={nvMiles} onChange={(e) => setNvMiles(e.target.value)} placeholder="From Maps" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Drive time (min)</label>
                              <input type="number" min="0" value={nvDriveTime} onChange={(e) => setNvDriveTime(e.target.value)} placeholder="From Maps" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Tolls (£)</label>
                              <input type="number" min="0" step="0.01" value={nvTolls} onChange={(e) => setNvTolls(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            </div>
                          </div>
                          <p className="text-xs text-gray-500">Miles &amp; drive time pre-fill the calculation and are saved to the venue for next time.</p>
                          <button
                            type="button"
                            onClick={handleCreateVenue}
                            disabled={creatingVenue || !nvName.trim()}
                            className="w-full px-4 py-2 bg-ooosh-600 text-white rounded-lg text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50"
                          >
                            {creatingVenue ? 'Creating…' : 'Create venue & use it'}
                          </button>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Distance (miles, one-way)</label>
                      <input type="number" value={formData.distanceMiles || ''} onChange={(e) => updateField('distanceMiles', parseFloat(e.target.value) || 0)} placeholder="From Google Maps" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Drive Time (minutes, one-way)</label>
                      <input type="number" value={formData.driveTimeMinutes || ''} onChange={(e) => updateField('driveTimeMinutes', parseFloat(e.target.value) || 0)} placeholder="From Google Maps" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    </div>
                  </div>

                  {needsTravelQuestion && (
                    <div className="border-t pt-6">
                      <h4 className="font-medium text-gray-900 mb-2">{formData.jobType === 'delivery' ? 'How does the driver get home?' : 'How does the driver get there?'}</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <select value={formData.travelMethod} onChange={(e) => updateField('travelMethod', e.target.value as FormData['travelMethod'])} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                            <option value="">Select...</option>
                            <option value="public_transport">Public transport (we pay)</option>
                            <option value="own_way">Gets a lift / own way</option>
                          </select>
                        </div>
                        {formData.travelMethod === 'public_transport' && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Travel Time (mins)</label>
                              <input type="number" value={formData.travelTimeMins || ''} onChange={(e) => updateField('travelTimeMins', parseFloat(e.target.value) || 0)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Ticket Cost (&pound;)</label>
                              <input type="number" value={formData.travelCost || ''} onChange={(e) => updateField('travelCost', parseFloat(e.target.value) || 0)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Pricing — D&C only. Crewed has its own block on Step 3. */}
                  {isDC && (
                    <div className="border-t pt-6">
                      <h4 className="font-medium text-gray-900 mb-1">💷 Pricing</h4>
                      <p className="text-xs text-gray-500 mb-4">Hourly works the time math from drive + handover + unload. Day rate is a flat fee per day — useful for long-haul or multi-day trips where the freelancer commits a whole day.</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
                          <select value={formData.calculationMode} onChange={(e) => updateField('calculationMode', e.target.value as QuoteCalcMode)} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                            <option value="hourly">Hourly rate</option>
                            <option value="dayrate">Day rate</option>
                          </select>
                        </div>
                        {formData.calculationMode === 'dayrate' && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Days</label>
                              <input type="number" value={formData.numberOfDays || ''} onChange={(e) => updateField('numberOfDays', parseInt(e.target.value) || 1)} min={1} disabled={formData.isMultiDay} className="w-full px-4 py-2 border border-gray-300 rounded-lg disabled:bg-gray-50 disabled:text-gray-500" />
                              {formData.isMultiDay && <p className="text-xs text-gray-500 mt-1">Auto from finish date</p>}
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Freelancer Day Rate (&pound;)</label>
                              <input type="number" value={formData.dayRateOverride ?? settings?.driver_day_rate ?? ''} onChange={(e) => updateField('dayRateOverride', e.target.value ? parseFloat(e.target.value) : null)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Client Day Rate (&pound;) <span className="text-gray-400 font-normal">optional</span></label>
                              <input type="number" value={formData.clientDayRateOverride ?? ''} onChange={(e) => updateField('clientDayRateOverride', e.target.value ? parseFloat(e.target.value) : null)} placeholder="Auto" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                            </div>
                          </>
                        )}
                      </div>
                      {formData.calculationMode === 'hourly' && (
                        <div className="mt-4">
                          <label className="flex items-center space-x-2">
                            <input type="checkbox" checked={formData.applyMinHours} onChange={(e) => updateField('applyMinHours', e.target.checked)} className="w-4 h-4 text-ooosh-600 rounded" />
                            <span className="text-sm font-medium text-gray-700">Apply min hours ({settings?.min_hours_threshold || 5}hr)</span>
                          </label>
                        </div>
                      )}
                      {formData.calculationMode === 'dayrate' && formData.addCollection && (
                        <div className="mt-4 px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 text-xs">
                          ⚠️ "Add collection from same location" pairs two quotes. In day-rate mode both quotes use the same Days value — usually you want separate single-day quotes for delivery and collection. Consider creating them as two separate quotes instead.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ─── STEP 3: WORK (Crewed only) ─── */}
              {step === 3 && isCrewedJob && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-gray-900">🔧 Work Details</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Work Type</label>
                      <select value={formData.workType} onChange={(e) => updateField('workType', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                        <option value="">Select...</option>
                        {WORK_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Number of Crew</label>
                      <input type="number" value={formData.crewCount} onChange={(e) => updateField('crewCount', Math.max(1, parseInt(e.target.value) || 1))} min={1} max={20} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                      {formData.crewCount > 1 && (
                        <p className="text-xs text-purple-600 mt-1">Costs will be multiplied by {formData.crewCount} crew</p>
                      )}
                    </div>
                    {formData.workType === 'other' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Describe the work</label>
                        <input type="text" value={formData.workTypeOther} onChange={(e) => updateField('workTypeOther', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                      </div>
                    )}
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Additional Notes</label>
                      <textarea value={formData.workDescription} onChange={(e) => updateField('workDescription', e.target.value)} rows={2} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    </div>
                  </div>

                  <div className="border-t pt-6">
                    <h4 className="font-medium text-gray-900 mb-4">Rate Calculation</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
                        <select value={formData.calculationMode} onChange={(e) => updateField('calculationMode', e.target.value as QuoteCalcMode)} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                          <option value="dayrate">Day rate</option>
                          <option value="hourly">Hourly rate</option>
                        </select>
                      </div>
                      {formData.calculationMode === 'hourly' && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Work Duration (hours)</label>
                          <input type="number" value={formData.workDurationHours || ''} onChange={(e) => updateField('workDurationHours', parseFloat(e.target.value) || 0)} min="0" step="0.5" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                        </div>
                      )}
                      {formData.calculationMode === 'dayrate' && (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Days</label>
                            <input type="number" value={formData.numberOfDays || ''} onChange={(e) => updateField('numberOfDays', parseInt(e.target.value) || 1)} min={1} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Freelancer Day Rate (&pound;)</label>
                            <input type="number" value={formData.dayRateOverride ?? settings?.driver_day_rate ?? ''} onChange={(e) => updateField('dayRateOverride', e.target.value ? parseFloat(e.target.value) : null)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Client Day Rate (&pound;) <span className="text-gray-400 font-normal">optional</span></label>
                            <input type="number" value={formData.clientDayRateOverride ?? ''} onChange={(e) => updateField('clientDayRateOverride', e.target.value ? parseFloat(e.target.value) : null)} placeholder="Auto" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          </div>
                        </>
                      )}
                    </div>
                    {formData.calculationMode === 'hourly' && (
                      <div className="mt-4">
                        <label className="flex items-center space-x-2">
                          <input type="checkbox" checked={formData.applyMinHours} onChange={(e) => updateField('applyMinHours', e.target.checked)} className="w-4 h-4 text-ooosh-600 rounded" />
                          <span className="text-sm font-medium text-gray-700">Apply min hours ({settings?.min_hours_threshold || 5}hr)</span>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* OOH for crewed hourly */}
                  {formData.calculationMode === 'hourly' && costs && <OOHDisplay costs={costs} formData={formData} onToggleOverride={() => updateField('oohManualOverride', !formData.oohManualOverride)} onChangeEarly={(v) => updateField('earlyStartMinutes', v)} onChangeLate={(v) => updateField('lateFinishMinutes', v)} />}
                </div>
              )}

              {/* ─── EXPENSES STEP ─── */}
              {((step === 3 && !isCrewedJob) || (step === 4 && isCrewedJob)) && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-gray-900">💷 Expenses</h3>

                  {!isCrewedJob && (
                    <div className="p-4 bg-gray-50 rounded-lg">
                      <label className="flex items-center space-x-2">
                        <input type="checkbox" checked={formData.applyMinHours} onChange={(e) => updateField('applyMinHours', e.target.checked)} className="w-4 h-4 text-ooosh-600 rounded" />
                        <span className="text-sm font-medium text-gray-700">Apply minimum hours ({settings?.min_hours_threshold || 5}hr)</span>
                      </label>
                    </div>
                  )}

                  {isDC && costs && <OOHDisplay costs={costs} formData={formData} onToggleOverride={() => updateField('oohManualOverride', !formData.oohManualOverride)} onChangeEarly={(v) => updateField('earlyStartMinutes', v)} onChangeLate={(v) => updateField('lateFinishMinutes', v)} />}

                  <p className="text-sm text-gray-500">
                    <span className="font-medium">In quote</span> = client pays it now ·{' '}
                    <span className="font-medium">Client pays</span> = they sort it separately ·{' '}
                    <span className="font-medium text-amber-700">Recharge</span> = we bill the actual + markup post-hire (amount is just an estimate). Tap a column heading to set every line at once.
                  </p>
                  <div className="border rounded-lg divide-y">
                    <div className="px-4 py-3 bg-gray-50 flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium text-gray-700">Category</div>
                      <div className="w-20 text-sm font-medium text-gray-700 text-right">Amount</div>
                      {([
                        ['included', 'In quote'],
                        ['not_included', 'Client pays'],
                        ['recharge', 'Recharge'],
                      ] as ['included' | 'not_included' | 'recharge', string][]).map(([m, label]) => (
                        <button key={m} type="button" onClick={() => setAllChargeMode(m)}
                          title={`Set every line to "${label}"`}
                          className={`w-[70px] text-center text-xs font-medium rounded px-1 py-0.5 hover:underline ${m === 'recharge' ? 'text-amber-700' : 'text-gray-600'}`}>
                          {label}
                        </button>
                      ))}
                      <div className="w-6" />
                    </div>
                    <div className="px-4">
                      {formData.expenses.map((expense) => (
                        <ExpenseRow
                          key={expense.id}
                          expense={expense}
                          fuelCost={costs?.expectedFuelCost}
                          numberOfDays={formData.numberOfDays}
                          onChange={updateExpense}
                          onRemove={expense.category === 'other' ? () => removeExpense(expense.id) : undefined}
                        />
                      ))}
                    </div>
                    <div className="px-4 py-3">
                      <button type="button" onClick={addOtherExpense} className="text-sm text-ooosh-600 hover:text-ooosh-800">+ Add other expense</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ─── REVIEW STEP ─── */}
              {step === totalSteps && costs && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-gray-900">📋 Review &amp; Save</h3>

                  {formData.addCollection && (
                    <div className="text-sm px-4 py-3 rounded-lg bg-ooosh-50 text-ooosh-700 border border-ooosh-200 text-center">
                      📦 Will save to D&amp;C board ({formData.addCollection ? '2 items' : '1 item'})
                    </div>
                  )}

                  {(costs.autoEarlyStartMinutes > 0 || costs.autoLateFinishMinutes > 0) && (
                    <div className="text-sm px-4 py-3 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
                      🌙 Out of hours: {costs.autoEarlyStartMinutes > 0 && `${formatDurationHM(costs.autoEarlyStartMinutes)} early start`}{costs.autoEarlyStartMinutes > 0 && costs.autoLateFinishMinutes > 0 && ' + '}{costs.autoLateFinishMinutes > 0 && `${formatDurationHM(costs.autoLateFinishMinutes)} late finish`}
                    </div>
                  )}

                  {/* Multi-crew info banner */}
                  {isCrewedJob && formData.crewCount > 1 && (
                    <div className="text-sm px-4 py-3 rounded-lg bg-purple-50 text-purple-700 border border-purple-200">
                      👥 {formData.crewCount} crew — costs below are the total for all {formData.crewCount} crew members
                    </div>
                  )}

                  {/* Recharge-post-hire notice — these are NOT in the quote total */}
                  {costs.expensesRecharge > 0 && (
                    <div className="text-sm px-4 py-3 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
                      ⛽ Plus running costs recharged post-hire (~&pound;{costs.expensesRecharge.toFixed(2)} est.) — billed at actual + 20%, not included in the quote total above. This job will be flagged "recharge running costs".
                    </div>
                  )}

                  {/* Cost summary cards */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-green-50 rounded-xl p-4">
                      <p className="text-sm text-green-600 font-medium">💰 Client Charge</p>
                      <p className="text-2xl font-bold text-green-700">&pound;{costs.clientChargeTotalRounded}</p>
                      <div className="mt-2 text-xs text-green-600 space-y-0.5">
                        <p>Labour: &pound;{costs.clientChargeLabour.toFixed(2)}</p>
                        <p>Fuel: &pound;{costs.clientChargeFuel.toFixed(2)}</p>
                        <p>Expenses: &pound;{costs.clientChargeExpenses.toFixed(2)}</p>
                      </div>
                    </div>
                    <div className="bg-blue-50 rounded-xl p-4">
                      <p className="text-sm text-blue-600 font-medium">🧑‍🔧 Freelancer Fee</p>
                      <p className="text-2xl font-bold text-blue-700">&pound;{costs.freelancerFeeRounded}</p>
                      <p className="mt-2 text-xs text-blue-600">Est. time: {costs.estimatedTimeHours.toFixed(1)} hours</p>
                    </div>
                    <div className="bg-purple-50 rounded-xl p-4">
                      <p className="text-sm text-purple-600 font-medium">📊 Our Margin</p>
                      <p className="text-2xl font-bold text-purple-700">&pound;{costs.ourMargin.toFixed(2)}</p>
                      <p className="mt-2 text-xs text-purple-600">Total cost: &pound;{costs.ourTotalCost.toFixed(2)}</p>
                    </div>
                  </div>

                  {/* Delivery + Collection breakdown (when addCollection is on) */}
                  {formData.addCollection && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-green-50/50 border border-green-200 rounded-xl p-4">
                          <p className="text-sm font-medium text-green-700">📦 Delivery</p>
                          <p className="text-xs text-gray-500 mt-0.5">{formatDateUK(formData.jobDate)}{formData.arrivalTime && ` @ ${formatTime12h(formData.arrivalTime)}`}</p>
                          <div className="mt-2 text-sm">
                            <p>Client: <span className="font-semibold">&pound;{costs.clientChargeTotalRounded}</span></p>
                            <p>Freelancer: <span className="font-semibold">&pound;{costs.freelancerFeeRounded}</span></p>
                          </div>
                        </div>
                        <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-4">
                          <p className="text-sm font-medium text-amber-700">📥 Collection</p>
                          <p className="text-xs text-gray-500 mt-0.5">{formData.collectionDate ? formatDateUK(formData.collectionDate) : 'TBC'}{formData.collectionArrivalTime && ` @ ${formatTime12h(formData.collectionArrivalTime)}`}</p>
                          <div className="mt-2 text-sm">
                            <p>Client: <span className="font-semibold">&pound;{costs.clientChargeTotalRounded}</span></p>
                            <p>Freelancer: <span className="font-semibold">&pound;{costs.freelancerFeeRounded}</span></p>
                          </div>
                        </div>
                      </div>
                      <div className="bg-gray-100 rounded-lg p-3 text-sm text-center">
                        <span className="font-medium">Combined totals:</span>{' '}
                        Client <span className="font-semibold">&pound;{costs.clientChargeTotalRounded * 2}</span>{' · '}
                        Freelancer <span className="font-semibold">&pound;{costs.freelancerFeeRounded * 2}</span>{' · '}
                        Margin <span className="font-semibold">&pound;{(costs.ourMargin * 2).toFixed(2)}</span>
                      </div>
                    </>
                  )}

                  {/* Job Summary */}
                  <div className="border rounded-lg divide-y">
                    <div className="px-4 py-3 bg-gray-50"><h4 className="font-medium text-gray-900">Job Summary</h4></div>
                    <div className="px-4 py-3 grid grid-cols-2 gap-3 text-sm">
                      <div><span className="text-gray-500">Type:</span> <span className="ml-1 capitalize">{formData.jobType}{isDC && formData.whatIsIt ? ` (${formData.whatIsIt})` : ''}{formData.includesSetupWork ? ' + Setup' : ''}</span></div>
                      {hhJobNumber && <div><span className="text-gray-500">HireHop #:</span> <span className="ml-1">{hhJobNumber}</span></div>}
                      {clientName && <div><span className="text-gray-500">Client:</span> <span className="ml-1">{clientName}</span></div>}
                      {formData.destination && <div><span className="text-gray-500">Destination:</span> <span className="ml-1">{formData.destination}</span></div>}
                      <div><span className="text-gray-500">{formData.jobType === 'collection' ? 'Collection:' : 'Delivery:'}</span> <span className="ml-1 font-medium">{formatDateUK(formData.jobDate)}{formData.arrivalTime && ` @ ${formatTime12h(formData.arrivalTime)}`}</span></div>
                      {formData.addCollection && formData.collectionDate && (
                        <div><span className="text-gray-500">Collection:</span> <span className="ml-1 font-medium">{formatDateUK(formData.collectionDate)}{formData.collectionArrivalTime && ` @ ${formatTime12h(formData.collectionArrivalTime)}`}</span></div>
                      )}
                      {formData.isMultiDay && formData.jobFinishDate && (
                        <div><span className="text-gray-500">Finish:</span> <span className="ml-1">{formatDateUK(formData.jobFinishDate)} ({formData.numberOfDays} days)</span></div>
                      )}
                      {formData.includesSetupWork && formData.setupWorkDescription && (
                        <div className="col-span-2"><span className="text-gray-500">Setup:</span> <span className="ml-1">{formData.setupWorkDescription}</span></div>
                      )}
                      {isCrewedJob && formData.workType && (
                        <div><span className="text-gray-500">Work:</span> <span className="ml-1">{WORK_TYPE_OPTIONS.find(o => o.value === formData.workType)?.label || formData.workType}{formData.workType === 'other' && formData.workTypeOther ? ` — ${formData.workTypeOther}` : ''}</span></div>
                      )}
                      {isCrewedJob && formData.crewCount > 1 && (
                        <div><span className="text-gray-500">Crew:</span> <span className="ml-1 font-medium text-purple-700">{formData.crewCount} people</span></div>
                      )}
                      {formData.distanceMiles > 0 && (
                        <div><span className="text-gray-500">Distance:</span> <span className="ml-1">{formData.distanceMiles} mi · {formData.driveTimeMinutes} mins</span></div>
                      )}
                    </div>
                  </div>

                  {/* Notes — two fields */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">🔒 Internal Notes <span className="text-gray-400 font-normal">(Ooosh only)</span></label>
                      <textarea value={formData.internalNotes} onChange={(e) => updateField('internalNotes', e.target.value)} placeholder="Margins, commercial notes..." rows={3} className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">📝 Freelancer Notes <span className="text-gray-400 font-normal">(visible to freelancer)</span></label>
                      <textarea value={formData.freelancerNotes} onChange={(e) => updateField('freelancerNotes', e.target.value)} placeholder="Expense info, what's included..." rows={3} className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Navigation */}
            <div className="flex justify-between mt-6">
              {step > 1 ? (
                <button onClick={() => setStep(step - 1)} disabled={!!success} className="px-6 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50">Back</button>
              ) : <div />}
              {step < totalSteps ? (
                <button
                  onClick={() => setStep(step + 1)}
                  disabled={(step === 1 && !isStep1Valid) || (step === 2 && !isStep2Valid) || (step === 3 && isCrewedJob && !isStep3Valid)}
                  className="px-6 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                </button>
              ) : (
                <button onClick={handleSave} disabled={saving || !!success} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                  {saving ? 'Saving...' : success ? 'Saved' : 'Save Quote'}
                </button>
              )}
            </div>

            {/* Live preview */}
            {costs && step > 1 && step < totalSteps && (
              <div className="hidden md:block fixed bottom-4 right-4 bg-white rounded-xl shadow-lg border p-4 max-w-xs z-50">
                <p className="text-sm text-gray-500 mb-2">Live Preview</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-500">Client:</span> <span className="ml-1 font-medium">&pound;{costs.clientChargeTotalRounded}</span></div>
                  <div><span className="text-gray-500">Freelancer:</span> <span className="ml-1 font-medium">&pound;{costs.freelancerFeeRounded}</span></div>
                </div>
                {formData.addCollection && <p className="text-xs text-ooosh-600 mt-1">&times; 2 (delivery + collection)</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function ExpenseRow({ expense, fuelCost, numberOfDays, onChange, onRemove }: {
  expense: QuoteExpenseItem; fuelCost?: number; numberOfDays: number;
  onChange: (e: QuoteExpenseItem) => void; onRemove?: () => void;
}) {
  const isOther = expense.category === 'other';
  const isPD = expense.category === 'pd';
  const isFuel = expense.category === 'fuel';

  useEffect(() => {
    if (isPD && expense.pdDays !== numberOfDays) onChange({ ...expense, pdDays: numberOfDays });
  }, [isPD, numberOfDays]);

  const displayAmount = isFuel ? (fuelCost || 0) : expense.amount;
  const mode: 'included' | 'not_included' | 'recharge' = expense.chargeMode ?? (expense.included ? 'included' : 'not_included');
  const labelColour = mode === 'included' ? 'text-gray-900' : mode === 'recharge' ? 'text-amber-700' : 'text-gray-400';
  const setMode = (m: 'included' | 'not_included' | 'recharge') => onChange({ ...expense, chargeMode: m, included: m === 'included' });
  const radioName = `charge-${expense.id}`;

  return (
    <div className="flex items-center gap-2 py-2 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        {isOther ? (
          <input type="text" value={expense.description || ''} onChange={(e) => onChange({ ...expense, description: e.target.value })} placeholder="Description..." className="w-full px-2 py-1 text-sm border border-gray-200 rounded" />
        ) : (
          <span className={`text-sm ${labelColour}`}>{expense.label}</span>
        )}
      </div>
      <div className="w-20">
        {isFuel ? (
          <div className="px-1.5 py-1 text-sm text-gray-500 bg-gray-50 rounded text-right">&pound;{displayAmount.toFixed(2)}</div>
        ) : isPD ? (
          <div className="flex items-center gap-0.5">
            <span className="text-gray-500 text-sm">&pound;</span>
            <input type="number" value={expense.amount || ''} onChange={(e) => onChange({ ...expense, amount: parseFloat(e.target.value) || 0 })} min="0" className="w-11 px-1 py-1 text-sm border border-gray-200 rounded text-right" />
            <span className="text-gray-500 text-[10px]">/day</span>
          </div>
        ) : (
          <div className="flex items-center gap-0.5">
            <span className="text-gray-500 text-sm">&pound;</span>
            <input type="number" value={expense.amount || ''} onChange={(e) => onChange({ ...expense, amount: parseFloat(e.target.value) || 0 })} min="0" className="w-full px-1.5 py-1 text-sm border border-gray-200 rounded text-right" />
          </div>
        )}
      </div>
      {(['included', 'not_included', 'recharge'] as const).map((m) => (
        <div key={m} className="w-[70px] flex justify-center">
          <input type="radio" name={radioName} checked={mode === m} onChange={() => setMode(m)}
            className={`w-4 h-4 ${m === 'recharge' ? 'accent-amber-600' : 'accent-ooosh-600'}`} />
        </div>
      ))}
      <div className="w-6 text-right">
        {isPD && expense.amount > 0 && expense.pdDays && expense.pdDays > 1 && (
          <span className="text-xs text-gray-500">&times;{expense.pdDays}</span>
        )}
        {isFuel && <span className="text-xs text-gray-400">(auto)</span>}
        {isOther && onRemove && (
          <button type="button" onClick={onRemove} className="text-red-500 hover:text-red-700 text-sm px-1">&times;</button>
        )}
      </div>
    </div>
  );
}

function OOHDisplay({ costs, formData, onToggleOverride, onChangeEarly, onChangeLate }: {
  costs: CalculatedCosts; formData: FormData;
  onToggleOverride: () => void; onChangeEarly: (v: number) => void; onChangeLate: (v: number) => void;
}) {
  const hasArrivalTime = !!formData.arrivalTime && formData.driveTimeMinutes > 0;
  const hasOOH = costs.autoEarlyStartMinutes > 0 || costs.autoLateFinishMinutes > 0;

  if (formData.oohManualOverride) {
    return (
      <div className="border-t pt-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-medium text-gray-900">Out of Hours (manual)</h4>
          <button type="button" onClick={onToggleOverride} className="text-sm text-ooosh-600 hover:text-ooosh-800">Switch to auto</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Early Start (mins before 8am)</label>
            <input type="number" value={formData.earlyStartMinutes || ''} onChange={(e) => onChangeEarly(parseFloat(e.target.value) || 0)} min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Late Finish (mins after 11pm)</label>
            <input type="number" value={formData.lateFinishMinutes || ''} onChange={(e) => onChangeLate(parseFloat(e.target.value) || 0)} min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t pt-6">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-gray-900">Out of Hours</h4>
        <button type="button" onClick={onToggleOverride} className="text-sm text-gray-500 hover:text-gray-700">Override manually</button>
      </div>
      {!hasArrivalTime ? (
        <p className="text-sm text-gray-400 italic">Enter arrival time and drive time to auto-calculate.</p>
      ) : hasOOH ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
          <p className="text-sm font-medium text-amber-800">🌙 Out of hours detected</p>
          {costs.autoEarlyStartMinutes > 0 && (
            <p className="text-sm text-amber-700">Departs {formatMinutesAsTime(costs.departureTimeMinutes)} — {formatDurationHM(costs.autoEarlyStartMinutes)} before 8am</p>
          )}
          {costs.autoLateFinishMinutes > 0 && (
            <p className="text-sm text-amber-700">Finishes ~{formatMinutesAsTime(costs.finishTimeMinutes)} — {formatDurationHM(costs.autoLateFinishMinutes)} after 11pm</p>
          )}
        </div>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-sm text-green-700">☀️ Within standard hours ({formatMinutesAsTime(costs.departureTimeMinutes)} — ~{formatMinutesAsTime(costs.finishTimeMinutes)})</p>
        </div>
      )}
    </div>
  );
}
