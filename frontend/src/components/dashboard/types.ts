/** Types for the Command Centre dashboard */

export interface ScheduleJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  status: number;
  pipeline_status: string | null;
  client_name: string | null;
  company_name: string | null;
  venue_name: string | null;
  job_date: string | null;
  job_end: string | null;
  out_date: string | null;
  return_date: string | null;
}

export interface TransportQuote {
  id: string;
  job_type: string;
  job_date: string | null;
  arrival_time: string | null;
  venue_name: string | null;
  ops_status: string;
  quote_status: string;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  crew: Array<{ first_name: string; last_name: string; role: string }>;
}

export interface VehicleAssignment {
  id: string;
  job_id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  assignment_status: string;
  reg: string | null;
  simple_type: string | null;
  make: string | null;
  model: string | null;
  driver_name: string | null;
  job_uuid: string;
  hh_job_number: number | null;
  job_name: string | null;
}

export interface UpcomingEvent {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  event_date: string;
  event_type: 'departure' | 'return';
}

export interface ChaseJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  next_chase_date: string;
  job_value: number | null;
  pipeline_status: string;
}

export interface PendingReferral {
  id: string;
  full_name: string;
  referral_status: string;
  licence_points: number | null;
  updated_at: string;
}

export interface PendingExcess {
  excess_id: string;
  excess_status: string;
  excess_amount_required: number | null;
  driver_name: string | null;
  vehicle_reg: string | null;
  job_uuid: string | null;
  hh_job_number: number | null;
  job_name: string | null;
}

export interface PipelineStat {
  pipeline_status: string;
  count: string;
  total_value: string;
}

export interface TeamMember {
  name: string;
  user_id: string;
  interaction_count: string;
  last_active: string | null;
}

export interface RecentActivity {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string;
  entity_name: string | null;
  entity_type: string | null;
  person_id: string | null;
  organisation_id: string | null;
  venue_id: string | null;
}

export interface BacklineStats {
  jobCount: number;
  notStarted?: number;
  inProgress?: number;
  done?: number;
  problem?: number;
  totalItems: number;
  totalPrepMins?: number;
  totalDeprepMins?: number;
  remainingPrepMins?: number;
  remainingDeprepMins?: number;
}

export interface BacklineOverview {
  goingOut: { stats: BacklineStats };
  returning: { stats: BacklineStats };
}

export interface OperationsData {
  stat_cards: {
    on_hire_count: string;
    going_out_count: string;
    coming_back_count: string;
    overdue_count: string;
    chases_due_count: string;
    open_enquiries_count: string;
  };
  today: {
    going_out: ScheduleJob[];
    returning: ScheduleJob[];
    transport_quotes: TransportQuote[];
    vehicle_assignments: VehicleAssignment[];
  };
  tomorrow: {
    going_out_count: number;
    returning_count: number;
  };
  upcoming_events: UpcomingEvent[];
  needs_attention: {
    overdue_returns: ScheduleJob[];
    chases_due: ChaseJob[];
    referral_count: number;
    referrals: PendingReferral[];
    excess_count: number;
    excess_total: number;
    excess_items: PendingExcess[];
  };
  transport_ops: {
    summary: Record<string, number>;
    unassigned_count: number;
  };
  fleet: {
    active_count: string;
    total_count: string;
    mot_due_soon: string;
    insurance_due_soon: string;
    tax_due_soon: string;
  };
  pipeline: {
    by_status: PipelineStat[];
    active_value: number;
  };
  team_activity: TeamMember[];
  recent_activity: RecentActivity[];
}
