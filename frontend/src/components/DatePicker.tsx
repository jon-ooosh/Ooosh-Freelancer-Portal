import { useState, useRef, useEffect, useCallback } from 'react';
import {
  format,
  parse,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
  isBefore,
  isAfter,
  isValid,
  eachDayOfInterval,
} from 'date-fns';

interface DatePickerProps {
  value: string; // yyyy-mm-dd
  onChange: (val: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function parseISO(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = parse(dateStr, 'yyyy-MM-dd', new Date());
  return isValid(d) ? d : null;
}

function toISO(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function displayDate(dateStr: string): string {
  const d = parseISO(dateStr);
  if (!d) return '';
  return format(d, 'dd/MM/yyyy');
}

export default function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled = false,
  className = '',
  placeholder = 'dd/mm/yyyy',
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Determine initial viewing month
  const getInitialMonth = useCallback(() => {
    const valDate = parseISO(value);
    if (valDate) return startOfMonth(valDate);
    const minDate = parseISO(min || '');
    if (minDate) return startOfMonth(minDate);
    return startOfMonth(new Date());
  }, [value, min]);

  const [viewMonth, setViewMonth] = useState(getInitialMonth);

  // Update viewMonth when value changes externally
  useEffect(() => {
    const valDate = parseISO(value);
    if (valDate) {
      setViewMonth(startOfMonth(valDate));
    }
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Position dropdown above or below
  useEffect(() => {
    if (!open || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setDropUp(spaceBelow < 320);
  }, [open]);

  const handleOpen = () => {
    if (disabled) return;
    setViewMonth(getInitialMonth());
    setOpen(true);
  };

  const handleDayClick = (day: Date) => {
    onChange(toISO(day));
    setOpen(false);
  };

  const handleClear = () => {
    onChange('');
    setOpen(false);
  };

  const handleToday = () => {
    const today = new Date();
    const minDate = parseISO(min || '');
    const maxDate = parseISO(max || '');
    if (minDate && isBefore(today, minDate)) return;
    if (maxDate && isAfter(today, maxDate)) return;
    onChange(toISO(today));
    setOpen(false);
  };

  const isDayDisabled = (day: Date): boolean => {
    const minDate = parseISO(min || '');
    const maxDate = parseISO(max || '');
    if (minDate && isBefore(day, minDate)) return true;
    if (maxDate && isAfter(day, maxDate)) return true;
    return false;
  };

  // Build calendar grid
  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(viewMonth);
  // Week starts on Monday (weekStartsOn: 1)
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const selectedDate = parseISO(value);
  const todayDate = new Date();

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Text input display */}
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={`w-full text-left border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-ooosh-500 focus:border-ooosh-500 focus:outline-none flex items-center justify-between ${
          disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white hover:border-gray-400 cursor-pointer'
        }`}
      >
        <span className={value ? 'text-gray-900' : 'text-gray-400'}>
          {value ? displayDate(value) : placeholder}
        </span>
        <svg className="w-4 h-4 text-gray-400 shrink-0 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>

      {/* Calendar dropdown */}
      {open && (
        <div
          ref={dropdownRef}
          className={`absolute z-[9999] bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-[280px] ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          style={{ left: 0 }}
        >
          {/* Month/Year navigation */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth(subMonths(viewMonth, 1))}
              className="p-1 rounded hover:bg-gray-100 text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-sm font-medium text-gray-800">
              {format(viewMonth, 'MMMM yyyy')}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth(addMonths(viewMonth, 1))}
              className="p-1 rounded hover:bg-gray-100 text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-center text-xs font-medium text-gray-400 py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const inMonth = isSameMonth(day, viewMonth);
              const isSelected = selectedDate && isSameDay(day, selectedDate);
              const isToday = isSameDay(day, todayDate);
              const isDisabled = isDayDisabled(day);

              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  disabled={isDisabled || !inMonth}
                  onClick={() => handleDayClick(day)}
                  className={`w-9 h-8 text-xs rounded flex items-center justify-center transition-colors ${
                    !inMonth
                      ? 'text-gray-200 cursor-default'
                      : isDisabled
                      ? 'text-gray-300 cursor-not-allowed'
                      : isSelected
                      ? 'bg-ooosh-600 text-white font-semibold'
                      : isToday
                      ? 'bg-ooosh-50 text-ooosh-700 font-semibold hover:bg-ooosh-100'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>

          {/* Footer buttons */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={handleClear}
              className="text-xs text-gray-500 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={handleToday}
              className="text-xs text-ooosh-600 hover:text-ooosh-700 px-2 py-1 rounded hover:bg-ooosh-50 font-medium"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
