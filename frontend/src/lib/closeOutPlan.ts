/**
 * closeOutPlan — one read of the hire close-out plan per job, shared by the
 * Invoice and Payment Reconciliation cards (HIRE-CLOSE-OUT-SPEC.md §3).
 *
 * The plan is a live read of HireHop (two calls), so two cards fetching it
 * independently would double the load on every Post-Hire tab. This keeps the
 * in-flight promise and the last result per job for a short while, and lets
 * one card tell the other when an action changed things.
 */
import { api } from '../services/api';

export interface CloseOutInvoice { invoiceId: number; number: string; status: number; date: string; gross: number; owing: number; inXero: boolean }
export interface CloseOutPayment { depositId: number; bankName: string | null; description: string; date: string; credit: number; available: number }
export interface CloseOutLogEntry { id: string; step: string; ok: boolean; detail: string; user_name: string | null; created_at: string }
export interface InvoicePlan {
  accruedNet: number;
  invoicedNet: number;
  netToInvoice: number;
  draft: CloseOutInvoice | null;
  euTrigger: boolean;
  notReturned: boolean;
  blockers: string[];
  ready: boolean;
}
export interface CloseOutPlan {
  hhJobNumber: number;
  hhStatus: number | null;
  invoice: InvoicePlan;
  invoices: CloseOutInvoice[];
  payments: CloseOutPayment[];
  allocations: Array<{ depositId: number; amount: number; invoiceNumber: string }>;
  surplus: Array<{ depositId: number; amount: number }>;
  shortfall: number;
  excessHeld: number;
  blockers: string[];
  warnings: string[];
  sentences: string[];
  ready: boolean;
  readyToComplete: boolean;
  log: CloseOutLogEntry[];
}
export interface CloseOutResult { done: boolean; message: string; plan: CloseOutPlan }

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; promise: Promise<CloseOutPlan> }>();
const listeners = new Map<string, Set<(plan: CloseOutPlan) => void>>();

/** Read the plan — from the last fetch if it is under 30 s old, unless `force`. */
export function loadCloseOutPlan(jobId: string, force = false): Promise<CloseOutPlan> {
  const hit = cache.get(jobId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = api.get<{ data: CloseOutPlan }>(`/close-out/${jobId}/plan`).then(r => {
    publish(jobId, r.data);
    return r.data;
  });
  promise.catch(() => cache.delete(jobId));
  cache.set(jobId, { at: Date.now(), promise });
  return promise;
}

/** An action returned a fresh plan — hand it to every card on the job. */
export function publishCloseOutPlan(jobId: string, plan: CloseOutPlan): void {
  cache.set(jobId, { at: Date.now(), promise: Promise.resolve(plan) });
  publish(jobId, plan);
}

export function subscribeCloseOutPlan(jobId: string, cb: (plan: CloseOutPlan) => void): () => void {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(cb);
  return () => { listeners.get(jobId)?.delete(cb); };
}

function publish(jobId: string, plan: CloseOutPlan) {
  listeners.get(jobId)?.forEach(cb => cb(plan));
}

export const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};
export const apiError = (e: unknown, fallback: string) =>
  (e as any)?.body?.error || (e as any)?.message || fallback;
