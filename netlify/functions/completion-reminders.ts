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
 * Business hours: Only sends between 7am and 10pm
 */

import type { Config, Context } from '@netlify/functions'

// =============================================================================
// CONFIGURATION
// =============================================================================

const MONDAY_API_URL = 'https://api.monday.com/v2'

// Column IDs from your Monday.com board
const DC_COLUMNS = {
  date: 'date4',
  timeToArrive: 'hour',
  status: 'status90',
  driverEmailMirror: 'driver_email__gc_',
  venueConnect: 'connect_boards6',
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
      'API-Version': '2025-04',
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
  // Use nodemailer via internal API call or direct SMTP
  // For simplicity, we'll call our own API endpoint
  
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
  
  const typeLabel = jobDetails.type === 'delivery' ? 'Delivery' : 'Collection'
  const urgencyText = reminderLevel === 1 
    ? 'Please complete it when you have a moment.'
    : reminderLevel === 2
      ? 'Please complete it as soon as possible.'
      : 'This is urgent - please complete it immediately or contact us.'
  
  const subject = reminderLevel === 3
    ? `🚨 URGENT: Please complete your ${typeLabel.toLowerCase()} - ${jobDetails.venue}`
    : `⏰ Reminder: Please complete your ${typeLabel.toLowerCase()} - ${jobDetails.venue}`

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
          ${reminderLevel === 3 ? '🚨' : '⏰'} ${typeLabel} Not Completed
        </h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hi ${firstName},</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          We noticed you haven't marked your ${typeLabel.toLowerCase()} as complete yet. ${urgencyText}
        </p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid ${reminderLevel === 3 ? '#ef4444' : '#f59e0b'};">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${jobDetails.venue}</h2>
          <p style="margin: 8px 0; color: #555;"><strong>Type:</strong> ${typeLabel}</p>
          <p style="margin: 8px 0; color: #555;"><strong>📅 Date:</strong> ${jobDetails.date}</p>
          <p style="margin: 8px 0; color: #555;"><strong>⏰ Expected time:</strong> ${jobDetails.time}</p>
        </div>
        
        <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
          Completing jobs in the portal helps us track deliveries and ensures you get paid promptly.
        </p>
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${appUrl}/job/${jobDetails.id}/complete" 
             style="display: inline-block; background: ${reminderLevel === 3 ? '#ef4444' : '#f59e0b'}; color: white; text-decoration: none; padding: 14px 35px; border-radius: 6px; font-weight: 600; font-size: 16px;">
            Complete ${typeLabel} Now
          </a>
        </div>
        
        ${reminderLevel >= 2 ? `
        <p style="font-size: 13px; color: #999; margin-top: 25px; text-align: center;">
          If there was a problem with this job, please reply to this email or contact us.
        </p>
        ` : ''}
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is reminder ${reminderLevel} of 3. This is an automated message from Ooosh Tours Ltd.
        </p>
      </div>
    </body>
    </html>
  `

  // Send via SMTP
  try {
    // We need to use nodemailer here
    // Since this is a Netlify function, we'll import dynamically
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
    linked_item_ids?: string[]
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

async function updateReminderLevel(itemId: string, level: number): Promise<void> {
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

    // Query for jobs that are confirmed but not completed
    // We need to check date is today or yesterday
    const query = `
      query {
        boards(ids: [${boardId}]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["${DC_COLUMNS.date}", "${DC_COLUMNS.timeToArrive}", "${DC_COLUMNS.status}", "${DC_COLUMNS.driverEmailMirror}", "${DC_COLUMNS.venueConnect}", "${DC_COLUMNS.completedAtDate}", "${DC_COLUMNS.completionReminderLevel}"]) {
                id
                text
                value
                ... on BoardRelationValue {
                  linked_item_ids
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
    let jobsChecked = 0

    for (const item of allItems) {
      // Build column map
      const columnMap = item.column_values.reduce((acc, col) => {
        acc[col.id] = col.text || ''
        return acc
      }, {} as Record<string, string>)

      const jobDate = columnMap[DC_COLUMNS.date]
      const jobTime = columnMap[DC_COLUMNS.timeToArrive]
      const status = columnMap[DC_COLUMNS.status]?.toLowerCase() || ''
      const driverEmail = columnMap[DC_COLUMNS.driverEmailMirror]
      const completedAt = columnMap[DC_COLUMNS.completedAtDate]
      const currentReminderLevel = parseInt(columnMap[DC_COLUMNS.completionReminderLevel] || '0') || 0
      const venueName = columnMap[DC_COLUMNS.venueConnect] || item.name

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

      console.log(`Completion Reminders: Job ${item.id} - ${hoursSince.toFixed(1)}h since job time, sending level ${nextLevel} reminder`)

      // Get driver name
      const driverName = await getDriverName(driverEmail)

      // Determine job type from name
      const jobType: 'delivery' | 'collection' = item.name.toLowerCase().includes('col') ? 'collection' : 'delivery'

      // Format date nicely
      const dateObj = new Date(jobDate)
      const formattedDate = dateObj.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })

      // Send reminder
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
        // Update reminder level in Monday
        await updateReminderLevel(item.id, nextLevel)
        remindersSent++
      }
    }

    console.log(`Completion Reminders: Checked ${jobsChecked} eligible jobs, sent ${remindersSent} reminders`)

    return new Response(JSON.stringify({
      success: true,
      jobsChecked,
      remindersSent,
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
