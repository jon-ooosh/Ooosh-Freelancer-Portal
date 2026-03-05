import { useAuthStore } from '../hooks/useAuthStore';

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Command Centre</h1>
      <p className="mt-1 text-sm text-gray-500">
        Welcome back, {user?.first_name}. Here's what's happening.
      </p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Placeholder cards — will be populated with live data */}
        <DashboardCard
          title="Today's Activity"
          items={[
            'Active hires on the road',
            'Deliveries & collections scheduled',
            'Equipment due back',
          ]}
          status="coming-soon"
        />
        <DashboardCard
          title="Needs Attention"
          items={[
            'Enquiries awaiting response',
            'Quotes pending confirmation',
            'Overdue invoices',
            'Outstanding issues',
          ]}
          status="coming-soon"
        />
        <DashboardCard
          title="Coming Up"
          items={[
            'Hires starting in 7 days',
            'Vehicles due for MOT',
            'Staff leave this week',
          ]}
          status="coming-soon"
        />
      </div>

      <div className="mt-8 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900">Phase 1 Status</h2>
        <p className="mt-2 text-sm text-gray-600">
          Core data model, authentication, contact management, and activity timeline.
          Currently in development with seed data.
        </p>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatusBadge label="People" status="active" />
          <StatusBadge label="Organisations" status="active" />
          <StatusBadge label="Venues" status="active" />
          <StatusBadge label="Interactions" status="active" />
          <StatusBadge label="Search" status="active" />
          <StatusBadge label="HireHop Sync" status="pending" />
          <StatusBadge label="Pipeline" status="phase-2" />
          <StatusBadge label="Deliveries" status="phase-3" />
        </div>
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  items,
  status,
}: {
  title: string;
  items: string[];
  status: 'live' | 'coming-soon';
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {status === 'coming-soon' && (
          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">
            Coming soon
          </span>
        )}
      </div>
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li key={item} className="text-sm text-gray-500 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-gray-300 rounded-full" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ label, status }: { label: string; status: 'active' | 'pending' | 'phase-2' | 'phase-3' }) {
  const colors = {
    active: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    'phase-2': 'bg-blue-100 text-blue-700',
    'phase-3': 'bg-purple-100 text-purple-700',
  };

  const labels = {
    active: 'Active',
    pending: 'Pending',
    'phase-2': 'Phase 2',
    'phase-3': 'Phase 3',
  };

  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs px-2 py-1 rounded-full ${colors[status]}`}>
        {labels[status]}
      </span>
      <span className="text-sm text-gray-700">{label}</span>
    </div>
  );
}
