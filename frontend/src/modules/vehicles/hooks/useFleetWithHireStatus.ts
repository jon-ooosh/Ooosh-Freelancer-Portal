/**
 * Enriched fleet data — cross-references vehicles with HireHop job statuses
 * via confirmed allocations.
 *
 * Provides the "live" picture of which vehicles are actually on hire,
 * which are available, and flags discrepancies between Fleet Master
 * and HireHop.
 */

import { useMemo } from 'react'
import { useVehicles } from './useVehicles'
import { useAllocations } from './useAllocations'
import { useUpcomingJobs, useUpcomingDueBackJobs } from './useHireHopJobs'
import type { Vehicle } from '../types/vehicle'
import type { VanAllocation, HireHopJob } from '../types/hirehop'

/** Enriched vehicle with live hire info from HireHop */
export interface EnrichedVehicle extends Vehicle {
  /** Active HireHop job this vehicle is allocated to (confirmed bookings only) */
  activeJob: {
    jobId: number
    jobName: string
    status: string
    outDate: string
    returnDate: string
  } | null

  /** Live status derived from HireHop + allocations */
  liveStatus: 'available' | 'on-hire' | 'returning' | 'prep-needed' | 'not-ready'

  /** Whether Fleet Master and HireHop disagree on status */
  statusMismatch: boolean

  /** The confirmed allocation record, if any */
  confirmedAllocation: VanAllocation | null
}

/**
 * Hook that provides enriched vehicle data with live HireHop status.
 *
 * Cross-references:
 * 1. Fleet Master (Monday.com) — base vehicle data + hireStatus
 * 2. Allocations (R2) — confirmed vehicle-to-job assignments
 * 3. HireHop jobs — live job statuses
 *
 * Returns the enriched fleet and summary stats.
 */
export function useFleetWithHireStatus() {
  const { data: vehicles, isLoading: vehiclesLoading } = useVehicles()
  const { data: allocations, isLoading: allocationsLoading } = useAllocations()
  const { data: goingOutJobs, isLoading: goingOutLoading } = useUpcomingJobs(14)
  const { data: dueBackJobs, isLoading: dueBackLoading } = useUpcomingDueBackJobs(14)

  const enrichedVehicles = useMemo(() => {
    if (!vehicles) return []

    const allocationsList = allocations || []
    const allJobs = [...(goingOutJobs || []), ...(dueBackJobs || [])]

    // Deduplicate jobs by ID
    const jobMap = new Map<number, HireHopJob>()
    for (const job of allJobs) {
      jobMap.set(job.id, job)
    }

    return vehicles
      .filter(v => !v.isOldSold)
      .map((vehicle): EnrichedVehicle => {
        // Find confirmed allocation for this vehicle
        const confirmedAlloc = allocationsList.find(
          a => a.vehicleId === vehicle.id && a.status === 'confirmed',
        ) || null

        // Look up the HireHop job status
        let activeJob: EnrichedVehicle['activeJob'] = null
        if (confirmedAlloc) {
          const job = jobMap.get(confirmedAlloc.hireHopJobId)
          if (job) {
            activeJob = {
              jobId: job.id,
              jobName: job.company || job.contactName || job.jobName,
              status: job.statusLabel,
              outDate: job.outDate,
              returnDate: job.returnDate,
            }
          } else {
            // Job exists in allocation but not in our fetched window
            activeJob = {
              jobId: confirmedAlloc.hireHopJobId,
              jobName: confirmedAlloc.hireHopJobName,
              status: 'Unknown',
              outDate: '',
              returnDate: '',
            }
          }
        }

        // Determine live status
        let liveStatus: EnrichedVehicle['liveStatus'] = 'available'
        if (vehicle.hireStatus === 'Not Ready') {
          liveStatus = 'not-ready'
        } else if (confirmedAlloc && activeJob) {
          // Check HireHop job status
          const jobStatus = activeJob.status
          if (['Dispatched', 'Part Dispatched'].includes(jobStatus)) {
            liveStatus = 'on-hire'
          } else if (['Returned', 'Returned Incomplete'].includes(jobStatus)) {
            liveStatus = 'returning'
          } else if (['Booked', 'Prepped'].includes(jobStatus)) {
            liveStatus = 'on-hire' // Job still active, vehicle is out
          } else {
            liveStatus = 'on-hire' // Default for confirmed allocation
          }
        } else if (vehicle.hireStatus === 'On Hire') {
          liveStatus = 'on-hire'
        } else if (vehicle.hireStatus === 'Prep Needed') {
          liveStatus = 'prep-needed'
        }

        // Check for mismatch between Fleet Master and HireHop
        // Note: "On Hire without allocation" is expected for vehicles booked out
        // before this system was in use, so we don't flag that as a mismatch.
        const statusMismatch = Boolean(
          // Fleet says Available but there's a confirmed allocation (should be On Hire)
          (vehicle.hireStatus === 'Available' && confirmedAlloc) ||
          // HireHop job says Returned but Fleet still says On Hire
          (activeJob && ['Returned', 'Returned Incomplete', 'Completed', 'Cancelled'].includes(activeJob.status) && vehicle.hireStatus === 'On Hire'),
        )

        return {
          ...vehicle,
          activeJob,
          liveStatus,
          statusMismatch,
          confirmedAllocation: confirmedAlloc,
        }
      })
  }, [vehicles, allocations, goingOutJobs, dueBackJobs])

  // Summary counts
  const stats = useMemo(() => {
    const counts = {
      available: 0,
      onHire: 0,
      prepNeeded: 0,
      notReady: 0,
      mismatches: 0,
    }
    for (const v of enrichedVehicles) {
      if (v.liveStatus === 'available') counts.available++
      else if (v.liveStatus === 'on-hire') counts.onHire++
      else if (v.liveStatus === 'prep-needed' || v.liveStatus === 'returning') counts.prepNeeded++
      else if (v.liveStatus === 'not-ready') counts.notReady++
      if (v.statusMismatch) counts.mismatches++
    }
    return counts
  }, [enrichedVehicles])

  return {
    vehicles: enrichedVehicles,
    stats,
    isLoading: vehiclesLoading || allocationsLoading || goingOutLoading || dueBackLoading,
  }
}
