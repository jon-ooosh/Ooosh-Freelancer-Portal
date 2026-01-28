/**
 * Completion Reminder Scheduled Function
 * 
 * Runs every 30 minutes via Netlify Scheduled Functions.
 * Checks for jobs that should have been completed but weren't,
 * and sends reminder emails to drivers.
 * 
 * Schedule: Every 30 minutes
 * 
 * Reminder levels:
 * - Level 1: 2 hours after job time
 * - Level 2: 6 hours after job time (2+4)
 * - Level 3: 14 hours after job time (6+8)
 * 
 * After level 3: Staff notification sent to info@oooshtours.co.uk
 * 
 * Business hours: Only sends between 7am and 10pm
 * 
 * IDEMPOTENCY: Updates Monday BEFORE sending email to prevent duplicates
 * if the function runs twice in quick succession.
 */

import type { Config, Context } from '@netlify/functions'

// =============================================================================
// CONFIGURATION
// =============================================================================

const MONDAY_API_URL = 'https://api.monday.com/v2'

// D&C Board ID for Monday.com links
const DC_BOARD_ID = '2028045828'

// Column IDs from your Monday.com board
const DC_COLUMNS = {
  date: 'date4',
  timeToArrive: 'hour',
  status: 'status90',
  deliverCollect: 'status_1',              // "Delivery" or "Collection" - use this for job type!
  driverEmailMirror: 'driver_email__gc_',
  venueMirror: 'mirror467',                // Mirrored venue name from Address Book
  completedAtDate: 'date_mkywpv0h',
  completionReminderLevel: 'text_mm00jreb',
}

// Reminder schedule (hours after job time)
const REMINDER_SCHEDULE = {
  1: 2,   // First reminder: 2 hours after
  2: 6,   // Second reminder: 6 hours after (2+4)
  3: 14,  // Third reminder: 14 hours after (6+8)
}

// Business hours (only send reminders during these times)
const BUSINESS_HOURS = {
  start: 7,   // 7am
  end: 22,    // 10pm
}

// Status that indicates job is confirmed but not completed
const CONFIRMED_STATUS = 'all arranged & email driver'

// Staff email for escalations
const STAFF_ALERT_EMAIL = 'info@oooshtours.co.uk'

// =============================================================================
// MONDAY.COM API HELPERS
// =============================================================================

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) {
    throw new Error('MONDAY_API_TOKEN not configured')
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10',  // Required for MirrorValue support
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status}`)
  }

  const data = await response.json()
  
  if (data.errors) {
    console.error('Monday API errors:', data.errors)
    throw new Error(`Monday API query error: ${JSON.stringify(data.errors)}`)
  }

  return data.data as T
}

// =============================================================================
// EMAIL SENDING
// =============================================================================

async function sendCompletionReminderEmail(
  to: string,
  driverName: string,
  jobDetails: {
    id: string
    name: string
    type: 'delivery' | 'collection'
    venue: string
    date: string
    time: string
  },
  reminderLevel: number
): Promise<boolean> {
  // Remove trailing slash from URL to prevent double-slash issues
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
  
  const typeLabel = jobDetails.type === 'delivery' ? 'delivery' : 'collection'
  const typeLabelCapitalised = jobDetails.type === 'delivery' ? 'Delivery' : 'Collection'
  
  // Urgency text now includes the problem disclaimer inline
  const urgencyText = reminderLevel === 1 
    ? 'Please complete it when you have a moment - if there was a problem with this job, please reply to this email or contact us asap.'
    : reminderLevel === 2
      ? 'Please complete it as soon as possible - if there was a problem with this job, please reply to this email or contact us asap.'
      : 'Please complete it immediately - if there was a problem with this job, please reply to this email or contact us asap.'
  
  // Subject format: "Reminder: please complete your delivery - Venue - Date"
  const subject = reminderLevel === 3
    ? `🚨 URGENT: please complete your ${typeLabel} - ${jobDetails.venue} - ${jobDetails.date}`
    : `⏰ Reminder: please complete your ${typeLabel} - ${jobDetails.venue} - ${jobDetails.date}`

  const firstName = driverName.split(' ')[0] || 'Driver'

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Completion Reminder</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: ${reminderLevel === 3 ? '#ef4444' : '#f59e0b'}; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">
          ${reminderLevel === 3 ? '🚨' : '⏰'} ${typeLabelCapitalised} Not Completed
        </h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hi ${firstName},</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          We noticed you haven't marked your ${typeLabel} as complete yet. ${urgencyText}
        </p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid ${reminderLevel === 3 ? '#ef4444' : '#f59e0b'};">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${typeLabelCapitalised} - ${jobDetails.venue}</h2>
          <p style="margin: 8px 0; color: #555;"><strong>📅 Date:</strong> ${jobDetails.date}</p>
          <p style="margin: 8px 0; color: #555;"><strong>⏰ Expected time:</strong> ${jobDetails.time}</p>
        </div>
        
        <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
          Completing jobs in the portal helps us track deliveries and ensures you get paid promptly.
        </p>
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${appUrl}/job/${jobDetails.id}/complete" 
             style="display: inline-block; background: ${reminderLevel === 3 ? '#ef4444' : '#f59e0b'}; color: white; text-decoration: none; padding: 14px 35px; border-radius: 6px; font-weight: 600; font-size: 16px;">
            Complete ${typeLabelCapitalised} Now
          </a>
        </div>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is reminder ${reminderLevel} of 3. This is an automated message from Ooosh Tours Ltd.
        </p>
      </div>
    </body>
    </html>
  `

  try {
    const nodemailer = await import('nodemailer')
    
    const transporter = nodemailer.default.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD,
      },
    })

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>',
      to,
      subject,
      html,
    })

    console.log(`Reminder ${reminderLevel} sent to ${to} for job ${jobDetails.id}`)
    return true
  } catch (error) {
    console.error(`Failed to send reminder to ${to}:`, error)
    return false
  }
}

/**
 * Send notification email to staff after all 3 reminders have been sent
 * Links to Monday.com board instead of portal
 */
async function sendStaffNotificationEmail(
  driverName: string,
  driverEmail: string,
  jobDetails: {
    id: string
    type: 'delivery' | 'collection'
    venue: string
    date: string
    time: string
  }
): Promise<boolean> {
  // Link to Monday.com board item directly
  const mondayUrl = `https://oooshtours.monday.com/boards/${DC_BOARD_ID}/pulses/${jobDetails.id}`
  const typeLabel = jobDetails.type === 'delivery' ? 'Delivery' : 'Collection'

  // Removed "Escalation" from subject
  const subject = `⚠️ ${typeLabel} - ${jobDetails.venue} - not completed after 3 reminders`

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Job Not Completed</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #dc2626; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">
          ⚠️ Job Not Completed - Manual Follow-up Required
        </h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">
          The following job has not been marked as complete despite 3 reminder emails. 
          Please follow up with the freelancer directly.
        </p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #dc2626;">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${typeLabel} - ${jobDetails.venue}</h2>
          <p style="margin: 8px 0; color: #555;"><strong>📅 Date:</strong> ${jobDetails.date}</p>
          <p style="margin: 8px 0; color: #555;"><strong>⏰ Expected time:</strong> ${jobDetails.time}</p>
          <p style="margin: 8px 0; color: #555;"><strong>👤 Driver:</strong> ${driverName}</p>
          <p style="margin: 8px 0; color: #555;"><strong>📧 Email:</strong> <a href="mailto:${driverEmail}">${driverEmail}</a></p>
        </div>
        
        <div style="background: #fef3c7; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
          <p style="margin: 0; color: #92400e; font-size: 14px;">
            <strong>Possible reasons:</strong> Freelancer may have forgotten, had phone issues, 
            or there may have been a problem with the job that needs discussing.
          </p>
        </div>
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${mondayUrl}" 
             style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 14px 35px; border-radius: 6px; font-weight: 600; font-size: 16px;">
            View Job in Monday.com
          </a>
        </div>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is an automated notification from the Ooosh Freelancer Portal.
        </p>
      </div>
    </body>
    </html>
  `

  try {
    const nodemailer = await import('nodemailer')
    
    const transporter = nodemailer.default.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD,
      },
    })

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>',
      to: STAFF_ALERT_EMAIL,
      subject,
      html,
    })

    console.log(`Staff notification sent for job ${jobDetails.id} (driver: ${driverEmail})`)
    return true
  } catch (error) {
    console.error(`Failed to send staff notification:`, error)
    return false
  }
}

// =============================================================================
// MAIN FUNCTION LOGIC
// =============================================================================

interface JobItem {
  id: string
  name: string
  column_values: Array<{
    id: string
    text: string
    value: string
    display_value?: string  // For mirror columns
  }>
}

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  if (!timeStr) return null
  
  // Try parsing JSON format from Monday (e.g., {"hour":14,"minute":30})
  try {
    const parsed = JSON.parse(timeStr)
    if (parsed.hour !== undefined) {
      return { hours: parsed.hour, minutes: parsed.minute || 0 }
    }
  } catch {
    // Not JSON, try text format
  }
  
  // Try parsing text format (e.g., "14:30" or "2:30 PM")
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/)
  if (match24) {
    return { hours: parseInt(match24[1]), minutes: parseInt(match24[2]) }
  }
  
  const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (match12) {
    let hours = parseInt(match12[1])
    const minutes = parseInt(match12[2])
    const isPM = match12[3].toUpperCase() === 'PM'
    if (isPM && hours !== 12) hours += 12
    if (!isPM && hours === 12) hours = 0
    return { hours, minutes }
  }
  
  return null
}

function isWithinBusinessHours(): boolean {
  const now = new Date()
  const hour = now.getHours()
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end
}

function getHoursSinceJobTime(jobDate: string, jobTime: string): number | null {
  if (!jobDate) return null
  
  const time = parseTime(jobTime)
  if (!time) return null
  
  // Parse job date and set time
  const jobDateTime = new Date(jobDate)
  if (isNaN(jobDateTime.getTime())) return null
  
  jobDateTime.setHours(time.hours, time.minutes, 0, 0)
  
  const now = new Date()
  const diffMs = now.getTime() - jobDateTime.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  
  return diffHours
}

function shouldSendReminder(currentLevel: number, hoursSinceJob: number): number | null {
  // currentLevel is what's already been sent (0, 1, 2, or 3)
  // Returns the next reminder level to send, or null if none
  
  if (currentLevel >= 3) return null // All reminders sent
  
  const nextLevel = currentLevel + 1
  const hoursRequired = REMINDER_SCHEDULE[nextLevel as keyof typeof REMINDER_SCHEDULE]
  
  if (hoursSinceJob >= hoursRequired) {
    return nextLevel
  }
  
  return null
}

/**
 * Update reminder level in Monday.com
 * Returns true if successful
 */
async function updateReminderLevel(itemId: string, level: number): Promise<boolean> {
  try {
    const boardId = process.env.MONDAY_BOARD_ID_DELIVERIES
    
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId, 
          item_id: $itemId, 
          column_id: $columnId, 
          value: $value
        ) {
          id
        }
      }
    `

    await mondayQuery(mutation, {
      boardId,
      itemId,
      columnId: DC_COLUMNS.completionReminderLevel,
      value: level.toString(),
    })
    
    return true
  } catch (error) {
    console.error(`Failed to update reminder level for job ${itemId}:`, error)
    return false
  }
}

async function getDriverName(email: string): Promise<string> {
  const boardId = process.env.MONDAY_BOARD_ID_FREELANCERS
  
  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: ["email"]) {
              id
              text
            }
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    boards: Array<{
      items_page: {
        items: Array<{
          id: string
          name: string
          column_values: Array<{ id: string; text: string }>
        }>
      }
    }>
  }>(query, { boardId: [boardId] })

  const items = result.boards[0]?.items_page?.items || []
  const freelancer = items.find(item => {
    const emailCol = item.column_values.find(col => col.id === 'email')
    return emailCol?.text?.toLowerCase().trim() === email.toLowerCase().trim()
  })

  return freelancer?.name || email
}

export default async function handler(req: Request, context: Context) {
  console.log('Completion Reminders: Starting check at', new Date().toISOString())
  
  // Check business hours
  if (!isWithinBusinessHours()) {
    console.log('Completion Reminders: Outside business hours, skipping')
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Outside business hours',
      skipped: true 
    }))
  }

  try {
    const boardId = process.env.MONDAY_BOARD_ID_DELIVERIES
    if (!boardId) {
      throw new Error('MONDAY_BOARD_ID_DELIVERIES not configured')
    }

    // Get today and yesterday's dates
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    
    const todayStr = today.toISOString().split('T')[0]
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    console.log(`Completion Reminders: Checking jobs for ${yesterdayStr} and ${todayStr}`)

    // Query for jobs - using MirrorValue fragment for venue name
    const query = `
      query {
        boards(ids: [${boardId}]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["${DC_COLUMNS.date}", "${DC_COLUMNS.timeToArrive}", "${DC_COLUMNS.status}", "${DC_COLUMNS.deliverCollect}", "${DC_COLUMNS.driverEmailMirror}", "${DC_COLUMNS.venueMirror}", "${DC_COLUMNS.completedAtDate}", "${DC_COLUMNS.completionReminderLevel}"]) {
                id
                text
                value
                ... on MirrorValue {
                  display_value
                }
              }
            }
          }
        }
      }
    `

    const result = await mondayQuery<{
      boards: Array<{
        items_page: {
          items: JobItem[]
        }
      }>
    }>(query)

    const allItems = result.boards[0]?.items_page?.items || []
    console.log(`Completion Reminders: Found ${allItems.length} total items`)

    let remindersSent = 0
    let staffNotificationsSent = 0
    let jobsChecked = 0

    for (const item of allItems) {
      // Build column map, handling mirror columns with display_value
      const columnMap: Record<string, string> = {}
      
      for (const col of item.column_values) {
        // For mirror columns, use display_value; otherwise use text
        const value = col.display_value !== undefined ? col.display_value : col.text
        columnMap[col.id] = value || ''
      }

      const jobDate = columnMap[DC_COLUMNS.date]
      const jobTime = columnMap[DC_COLUMNS.timeToArrive]
      const status = columnMap[DC_COLUMNS.status]?.toLowerCase() || ''
      const deliverCollectText = columnMap[DC_COLUMNS.deliverCollect]?.toLowerCase() || ''
      const driverEmail = columnMap[DC_COLUMNS.driverEmailMirror]
      const venueName = columnMap[DC_COLUMNS.venueMirror] || item.name  // Fall back to item name
      const completedAt = columnMap[DC_COLUMNS.completedAtDate]
      const currentReminderLevel = parseInt(columnMap[DC_COLUMNS.completionReminderLevel] || '0') || 0

      // Skip if not today or yesterday
      if (jobDate !== todayStr && jobDate !== yesterdayStr) {
        continue
      }

      // Skip if already completed
      if (completedAt) {
        continue
      }

      // Skip if status is not exactly "All arranged & email driver"
      if (!status.includes('all arranged & email driver')) {
        continue
      }

      // Skip if no driver assigned
      if (!driverEmail) {
        continue
      }

      // Skip if all reminders already sent
      if (currentReminderLevel >= 3) {
        continue
      }

      jobsChecked++

      // Calculate hours since job time
      const hoursSince = getHoursSinceJobTime(jobDate, jobTime)
      if (hoursSince === null || hoursSince < 0) {
        // Job time hasn't passed yet
        continue
      }

      // Check if we should send a reminder
      const nextLevel = shouldSendReminder(currentReminderLevel, hoursSince)
      if (nextLevel === null) {
        continue
      }

      console.log(`Completion Reminders: Job ${item.id} (${venueName}) - ${hoursSince.toFixed(1)}h since job time, sending level ${nextLevel} reminder`)

      // IDEMPOTENCY FIX: Update Monday FIRST before sending email
      // This prevents duplicate emails if the function runs twice
      const updateSuccess = await updateReminderLevel(item.id, nextLevel)
      
      if (!updateSuccess) {
        console.error(`Completion Reminders: Failed to update level for job ${item.id}, skipping email`)
        continue
      }

      // Get driver name
      const driverName = await getDriverName(driverEmail)

      // Determine job type from deliverCollect column (not item name!)
      const jobType: 'delivery' | 'collection' = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

      // Format date nicely
      const dateObj = new Date(jobDate)
      const formattedDate = dateObj.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })

      // Send reminder (Monday already updated, so even if this fails we won't send duplicate)
      const sent = await sendCompletionReminderEmail(
        driverEmail,
        driverName,
        {
          id: item.id,
          name: item.name,
          type: jobType,
          venue: venueName,
          date: formattedDate,
          time: jobTime || 'TBC',
        },
        nextLevel
      )

      if (sent) {
        remindersSent++

        // If this was the 3rd reminder, also send staff notification
        if (nextLevel === 3) {
          const notificationSent = await sendStaffNotificationEmail(
            driverName,
            driverEmail,
            {
              id: item.id,
              type: jobType,
              venue: venueName,
              date: formattedDate,
              time: jobTime || 'TBC',
            }
          )
          if (notificationSent) {
            staffNotificationsSent++
          }
        }
      } else {
        // Email failed but level was updated - log this
        console.warn(`Completion Reminders: Email failed for job ${item.id} but level was updated to ${nextLevel}`)
      }
    }

    console.log(`Completion Reminders: Checked ${jobsChecked} eligible jobs, sent ${remindersSent} reminders, ${staffNotificationsSent} staff notifications`)

    return new Response(JSON.stringify({
      success: true,
      jobsChecked,
      remindersSent,
      staffNotificationsSent,
      timestamp: new Date().toISOString(),
    }))

  } catch (error) {
    console.error('Completion Reminders: Error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), { status: 500 })
  }
}

// Netlify Scheduled Function configuration
export const config: Config = {
  // Run every 30 minutes
  schedule: '*/30 * * * *',
}