import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

interface SearchResult {
  id: string;
  name: string;
  subtitle: string | null;
  type: 'person' | 'organisation' | 'venue' | 'job';
}

const typeLabels: Record<string, string> = {
  person: 'Person',
  organisation: 'Org',
  venue: 'Venue',
  job: 'Job',
};

const typeColors: Record<string, string> = {
  person: 'bg-blue-100 text-blue-700',
  organisation: 'bg-purple-100 text-purple-700',
  venue: 'bg-teal-100 text-teal-700',
  job: 'bg-amber-100 text-amber-700',
};

export default function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const navigate = useNavigate();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+K to focus search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query.trim())}`);
        setResults(data.results);
        setIsOpen(true);
        setSelectedIndex(-1);
      } catch (err) {
        console.error('Search failed:', err);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function navigateToResult(result: SearchResult) {
    const paths: Record<string, string> = {
      person: `/people/${result.id}`,
      organisation: `/organisations/${result.id}`,
      venue: `/venues/${result.id}`,
      job: `/jobs/${result.id}`,
    };
    navigate(paths[result.type]);
    setQuery('');
    setIsOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i < results.length - 1 ? i + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i > 0 ? i - 1 : results.length - 1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      navigateToResult(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search... (Ctrl+K)"
          className="w-48 lg:w-64 rounded-md bg-ooosh-700 border border-ooosh-600 px-3 py-1.5 text-sm text-white placeholder-ooosh-300 focus:outline-none focus:ring-1 focus:ring-ooosh-400 focus:bg-ooosh-600"
        />
        {loading && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-ooosh-300 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <div className="absolute top-full mt-1 w-80 lg:w-96 bg-white rounded shadow-lg border border-gray-200 max-h-80 overflow-y-auto z-50 right-0">
          {results.map((result, index) => (
            <button
              key={`${result.type}-${result.id}`}
              onClick={() => navigateToResult(result)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors ${
                index === selectedIndex ? 'bg-gray-50' : ''
              } ${index > 0 ? 'border-t border-gray-100' : ''}`}
            >
              <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${typeColors[result.type]}`}>
                {typeLabels[result.type]}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{result.name}</p>
                {result.subtitle && (
                  <p className="text-xs text-gray-500 truncate">{result.subtitle}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {isOpen && query.trim().length >= 2 && results.length === 0 && !loading && (
        <div className="absolute top-full mt-1 w-80 lg:w-96 bg-white rounded shadow-lg border border-gray-200 z-50 right-0 p-4">
          <p className="text-sm text-gray-500 text-center">No results found</p>
        </div>
      )}
    </div>
  );
}
