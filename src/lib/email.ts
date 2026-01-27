/**
 * Email Service
 * 
 * Handles sending email notifications via nodemailer.
 * Used for:
 * - Job confirmation emails to freelancers
 * - Job update notifications
 * - Job cancellation notifications
 * - Email verification during registration
 * - Driver notes alerts to staff
 * - Client delivery notes (with PDF attachment)
 * - Client collection confirmations
 */

import nodemailer from 'nodemailer'

// =============================================================================
// CONFIGURATION
// =============================================================================

const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
}

const FROM_ADDRESS = process.env.EMAIL_FROM || 'Ooosh Tours <noreply@oooshtours.co.uk>'
const STAFF_ALERT_EMAIL = 'info@oooshtours.co.uk'

// Helper to get app URL without trailing slash
function getAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
  return url.replace(/\/$/, '') // Remove trailing slash if present
}

// =============================================================================
// TRANSPORTER
// =============================================================================

let transporter: nodemailer.Transporter | null = null

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(EMAIL_CONFIG)
  }
  return transporter
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return 'th'
  }
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

/**
 * Format date as "27th Jan, 2026" for email subject lines
 */
function formatDateShort(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    
    const day = date.getDate()
    const ordinal = getOrdinalSuffix(day)
    const month = date.toLocaleDateString('en-GB', { month: 'short' })
    const year = date.getFullYear()
    
    return `${day}${ordinal} ${month}, ${year}`
  } catch {
    return dateStr
  }
}

/**
 * Format date nicely for email bodies - e.g., "Monday, 27 January 2026"
 */
function formatDateNice(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  } catch {
    return dateStr
  }
}

/**
 * Format time nicely - e.g., "14:30" or "TBC"
 */
function formatTime(timeStr?: string): string {
  if (!timeStr) return 'TBC'
  return timeStr
}

/**
 * Get the job type label
 */
function getJobTypeLabel(type: 'delivery' | 'collection'): string {
  return type === 'delivery' ? 'Delivery' : 'Collection'
}

// =============================================================================
// EMAIL TEMPLATES
// =============================================================================

interface JobDetails {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  time?: string
  venue: string
  address?: string
  keyNotes?: string
}

interface RelatedJob {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  venue: string
}

/**
 * Generate job confirmation email HTML
 */
function generateJobConfirmationEmail(jobDetails: JobDetails, freelancerName: string): string {
  const typeLabel = getJobTypeLabel(jobDetails.type)
  const typeIcon = jobDetails.type === 'delivery' ? '📦' : '🚚'
  const formattedDate = formatDateNice(jobDetails.date)
  const formattedTime = formatTime(jobDetails.time)
  const appUrl = getAppUrl()
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Job Confirmed</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${typeIcon} ${typeLabel} Confirmed</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hi ${freelancerName},</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">You have been assigned a new ${typeLabel.toLowerCase()}:</p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #667eea;">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${jobDetails.venue}</h2>
          
          <p style="margin: 8px 0; color: #555;">
            <strong>📅 Date:</strong> ${formattedDate}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>⏰ Arrive by:</strong> ${formattedTime}
          </p>
          ${jobDetails.address ? `
          <p style="margin: 8px 0; color: #555;">
            <strong>📍 Address:</strong> ${jobDetails.address}
          </p>
          ` : ''}
          ${jobDetails.keyNotes ? `
          <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #eee;">
            <strong>📋 Notes:</strong>
            <p style="margin: 8px 0; color: #555; white-space: pre-wrap;">${jobDetails.keyNotes}</p>
          </div>
          ` : ''}
        </div>
        
        <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
          You can view full job details and access information in the Ooosh portal.
        </p>
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${appUrl}/job/${jobDetails.id}" 
             style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 600;">
            View Job Details
          </a>
        </div>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is an automated message from Ooosh Tours Ltd.
        </p>
      </div>
    </body>
    </html>
  `
}

/**
 * Generate job update email HTML
 */
function generateJobUpdateEmail(jobDetails: JobDetails, freelancerName: string): string {
  const typeLabel = getJobTypeLabel(jobDetails.type)
  const formattedDate = formatDateNice(jobDetails.date)
  const formattedTime = formatTime(jobDetails.time)
  const appUrl = getAppUrl()
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Job Updated</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #f59e0b; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">🔄 Job Updated</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hi ${freelancerName},</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">A job assigned to you has been updated. Please check the latest details:</p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #f59e0b;">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${jobDetails.venue}</h2>
          <p style="margin: 8px 0; color: #555;"><strong>Type:</strong> ${typeLabel}</p>
          <p style="margin: 8px 0; color: #555;"><strong>📅 Date:</strong> ${formattedDate}</p>
          <p style="margin: 8px 0; color: #555;"><strong>⏰ Time:</strong> ${formattedTime}</p>
        </div>
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${appUrl}/job/${jobDetails.id}" 
             style="display: inline-block; background: #f59e0b; color: white; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 600;">
            View Updated Details
          </a>
        </div>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is an automated message from Ooosh Tours Ltd.
        </p>
      </div>
    </body>
    </html>
  `
}

/**
 * Generate job cancellation email HTML
 */
function generateJobCancellationEmail(jobDetails: JobDetails, freelancerName: string): string {
  const typeLabel = getJobTypeLabel(jobDetails.type)
  const formattedDate = formatDateNice(jobDetails.date)
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Job Cancelled</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #ef4444; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">❌ Job Cancelled</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hi ${freelancerName},</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">Unfortunately, the following job has been cancelled:</p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #ef4444;">
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${jobDetails.venue}</h2>
          <p style="margin: 8px 0; color: #555;"><strong>Type:</strong> ${typeLabel}</p>
          <p style="margin: 8px 0; color: #555;"><strong>📅 Date:</strong> ${formattedDate}</p>
        </div>
        
        <p style="font-size: 14px; color: #666;">
          We apologise for any inconvenience. If you have any questions, please get in touch with the Ooosh team.
        </p>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is an automated message from Ooosh Tours Ltd.
        </p>
      </div>
    </body>
    </html>
  `
}

/**
 * Generate driver notes alert email HTML for staff
 */
function generateDriverNotesAlertEmail(
  jobDetails: JobDetails,
  driverName: string,
  notes: string,
  relatedJobs: RelatedJob[]
): string {
  const typeLabel = getJobTypeLabel(jobDetails.type)
  const typeIcon = jobDetails.type === 'delivery' ? '📦' : '🚚'
  const formattedDate = formatDateNice(jobDetails.date)
  const appUrl = getAppUrl()
  
  // Build related jobs HTML if any exist
  let relatedJobsHtml = ''
  if (relatedJobs.length > 0) {
    const jobItems = relatedJobs.map(rj => {
      const rjTypeLabel = getJobTypeLabel(rj.type)
      const rjTypeIcon = rj.type === 'delivery' ? '📦' : '🚚'
      const rjFormattedDate = formatDateShort(rj.date)
      return `
        <li style="margin: 8px 0; padding: 8px 0; border-bottom: 1px solid #eee;">
          ${rjTypeIcon} <strong>${rjTypeLabel}</strong> - ${rj.venue}<br>
          <span style="color: #666; font-size: 13px;">📅 ${rjFormattedDate}</span>
          <a href="${appUrl}/job/${rj.id}" style="color: #667eea; text-decoration: none; font-size: 13px; margin-left: 10px;">View →</a>
        </li>
      `
    }).join('')
    
    relatedJobsHtml = `
      <div style="background: #fff3cd; border-radius: 8px; padding: 15px; margin-top: 20px; border-left: 4px solid #ffc107;">
        <h3 style="margin: 0 0 10px 0; color: #856404; font-size: 14px;">⚠️ Related Upcoming Jobs (same venue or HH ref)</h3>
        <p style="margin: 0 0 10px 0; color: #856404; font-size: 13px;">Consider if this note should be added to any of these:</p>
        <ul style="margin: 0; padding-left: 20px; list-style: none;">
          ${jobItems}
        </ul>
      </div>
    `
  }
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Driver Note Submitted</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #17a2b8; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">📝 Driver Note Submitted</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #17a2b8;">
          <p style="margin: 0 0 5px 0; color: #666; font-size: 13px;">JOB DETAILS</p>
          <h2 style="margin: 0 0 15px 0; color: #333; font-size: 18px;">${typeIcon} ${typeLabel} - ${jobDetails.venue}</h2>
          
          <p style="margin: 8px 0; color: #555;">
            <strong>📅 Date:</strong> ${formattedDate}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>👤 Driver:</strong> ${driverName}
          </p>
        </div>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #28a745;">
          <p style="margin: 0 0 10px 0; color: #666; font-size: 13px;">DRIVER'S NOTE</p>
          <p style="margin: 0; color: #333; white-space: pre-wrap; font-size: 15px;">${notes}</p>
        </div>
        
        ${relatedJobsHtml}
        
        <div style="text-align: center; margin-top: 25px;">
          <a href="${appUrl}/job/${jobDetails.id}" 
             style="display: inline-block; background: #17a2b8; color: white; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 600;">
            View Job in Portal
          </a>
        </div>
        
        <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
          This is an automated alert from the Ooosh Freelancer Portal.
        </p>
      </div>
    </body>
    </html>
  `
}

/**
 * Generate client delivery note email HTML
 */
function generateClientDeliveryNoteEmail(
  venueName: string,
  jobDate: string,
  hhRef: string
): string {
  const formattedDate = formatDateNice(jobDate)
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Delivery Note - Ooosh Tours</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">📦 Delivery Note</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hello,</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          Please find attached the delivery note for your recent equipment hire from Ooosh Tours.
        </p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #667eea;">
          <p style="margin: 8px 0; color: #555;">
            <strong>📍 Venue:</strong> ${venueName}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>📅 Date:</strong> ${formattedDate}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>🔖 Job Reference:</strong> ${hhRef}
          </p>
        </div>
        
        <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
          The attached PDF contains a full list of the equipment delivered. If you have any questions or notice any discrepancies, please get in touch asap.
        </p>
        
        <p style="font-size: 14px; color: #555; margin-top: 25px;">
          Many thanks,<br>
          <strong>The Ooosh Tours Team</strong>
        </p>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #999; margin: 0;">
            Ooosh Tours Ltd | Compass House, 7 East Street, Portslade, BN41 1DL
          </p>
          <p style="font-size: 12px; color: #999; margin: 5px 0 0 0;">
            <a href="https://www.oooshtours.co.uk" style="color: #667eea; text-decoration: none;">www.oooshtours.co.uk</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `
}

/**
 * Generate client collection confirmation email HTML
 */
function generateClientCollectionConfirmationEmail(
  venueName: string,
  jobDate: string,
  hhRef: string
): string {
  const formattedDate = formatDateNice(jobDate)
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Collection Confirmation - Ooosh Tours</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">🚚 Collection Complete</h1>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; margin-bottom: 20px;">Hello,</p>
        
        <p style="font-size: 16px; margin-bottom: 20px;">
          This is an automated email to let you know we've collected your equipment for job <strong>${hhRef}</strong> from <strong>${venueName}</strong>.
        </p>
        
        <div style="background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; border-left: 4px solid #667eea;">
          <p style="margin: 8px 0; color: #555;">
            <strong>📍 Venue:</strong> ${venueName}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>📅 Collection Date:</strong> ${formattedDate}
          </p>
          <p style="margin: 8px 0; color: #555;">
            <strong>🔖 Job Reference:</strong> ${hhRef}
          </p>
        </div>
        
        <div style="background: #fff8e6; border-radius: 8px; padding: 15px; margin-bottom: 20px; border-left: 4px solid #f59e0b;">
          <p style="margin: 0; color: #92400e; font-size: 14px;">
            <strong>📋 Please note:</strong> This is a collection only - we'll verify all items are present and in good condition once everything is back at our warehouse. We'll be in touch if there are any issues.
          </p>
        </div>
        
        <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
          Thanks for choosing Ooosh Tours! If you have any questions, please get in touch.
        </p>
        
        <p style="font-size: 14px; color: #555; margin-top: 25px;">
          Cheers,<br>
          <strong>The Ooosh Tours Team</strong>
        </p>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #999; margin: 0;">
            Ooosh Tours Ltd | Compass House, 7 East Street, Portslade, BN41 1DL
          </p>
          <p style="font-size: 12px; color: #999; margin: 5px 0 0 0;">
            <a href="https://www.oooshtours.co.uk" style="color: #667eea; text-decoration: none;">www.oooshtours.co.uk</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `
}

// =============================================================================
// EMAIL SENDING FUNCTIONS
// =============================================================================

/**
 * Send job confirmation email to freelancer
 */
export async function sendJobConfirmedNotification(
  freelancerEmail: string,
  freelancerName: string,
  jobDetails: JobDetails
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if email is configured
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping notification')
      return { success: true } // Return success to not block the flow
    }

    const transport = getTransporter()
    
    // Use first name only for cleaner email
    const firstName = freelancerName.split(' ')[0]
    
    // Extract subject name from job name or venue - use first name for personalization
    const subjectName = firstName || 'You'
    
    // Format date for subject line (e.g., "27th Jan, 2026")
    const formattedDateShort = formatDateShort(jobDetails.date)
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: freelancerEmail,
      subject: `${subjectName}, new job on ${formattedDateShort}`,
      html: generateJobConfirmationEmail(jobDetails, firstName),
    })

    console.log(`Job confirmation email sent to ${freelancerEmail}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send job confirmation email:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send job update email to freelancer
 */
export async function sendJobUpdatedNotification(
  freelancerEmail: string,
  freelancerName: string,
  jobDetails: JobDetails
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping notification')
      return { success: true }
    }

    const transport = getTransporter()
    const firstName = freelancerName.split(' ')[0]
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: freelancerEmail,
      subject: `Job updated - ${jobDetails.venue}`,
      html: generateJobUpdateEmail(jobDetails, firstName),
    })

    console.log(`Job update email sent to ${freelancerEmail}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send job update email:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send job cancellation email to freelancer
 */
export async function sendJobCancelledNotification(
  freelancerEmail: string,
  freelancerName: string,
  jobDetails: JobDetails
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping notification')
      return { success: true }
    }

    const transport = getTransporter()
    const firstName = freelancerName.split(' ')[0]
    
    // Format date for subject line (e.g., "27th Jan, 2026")
    const formattedDateShort = formatDateShort(jobDetails.date)
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: freelancerEmail,
      subject: `Job cancelled - ${formattedDateShort} - ${jobDetails.venue}`,
      html: generateJobCancellationEmail(jobDetails, firstName),
    })

    console.log(`Job cancellation email sent to ${freelancerEmail}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send job cancellation email:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send driver notes alert email to staff
 * Called when a freelancer submits completion notes
 */
export async function sendDriverNotesAlert(
  driverName: string,
  jobDetails: JobDetails,
  notes: string,
  relatedJobs: RelatedJob[]
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping driver notes alert')
      return { success: true }
    }

    const transport = getTransporter()
    
    // Format date for subject line
    const formattedDateShort = formatDateShort(jobDetails.date)
    const typeLabel = getJobTypeLabel(jobDetails.type)
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: STAFF_ALERT_EMAIL,
      subject: `📝 Driver Note: ${typeLabel} - ${jobDetails.venue} - ${formattedDateShort}`,
      html: generateDriverNotesAlertEmail(jobDetails, driverName, notes, relatedJobs),
    })

    console.log(`Driver notes alert sent to ${STAFF_ALERT_EMAIL}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send driver notes alert:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send delivery note email to client(s) with PDF attachment
 * 
 * @param clientEmails - Array of email addresses to send to
 * @param venueName - Venue name for the job
 * @param jobDate - Date of the job
 * @param hhRef - HireHop job reference
 * @param pdfBuffer - The generated PDF as a Buffer
 */
export async function sendClientDeliveryNote(
  clientEmails: string[],
  venueName: string,
  jobDate: string,
  hhRef: string,
  pdfBuffer: Buffer
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping client delivery note')
      return { success: true }
    }

    if (clientEmails.length === 0) {
      console.warn('No client emails provided, skipping delivery note')
      return { success: true }
    }

    const transport = getTransporter()
    
    // Format date for subject line
    const formattedDateShort = formatDateShort(jobDate)
    
    // Create filename for attachment
    const safeVenueName = venueName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
    const filename = `Ooosh_Delivery_Note_${hhRef}_${safeVenueName}.pdf`
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: clientEmails.join(', '),
      subject: `📦 Delivery Note - ${venueName} - ${formattedDateShort} (Ref: ${hhRef})`,
      html: generateClientDeliveryNoteEmail(venueName, jobDate, hhRef),
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        }
      ],
    })

    console.log(`Client delivery note sent to ${clientEmails.join(', ')}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send client delivery note:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send collection confirmation email to client(s)
 * No PDF attachment - just a friendly confirmation with caveat about item verification
 * 
 * @param clientEmails - Array of email addresses to send to
 * @param venueName - Venue name for the job
 * @param jobDate - Date of the job
 * @param hhRef - HireHop job reference
 */
export async function sendClientCollectionConfirmation(
  clientEmails: string[],
  venueName: string,
  jobDate: string,
  hhRef: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.warn('Email not configured, skipping client collection confirmation')
      return { success: true }
    }

    if (clientEmails.length === 0) {
      console.warn('No client emails provided, skipping collection confirmation')
      return { success: true }
    }

    const transport = getTransporter()
    
    // Format date for subject line
    const formattedDateShort = formatDateShort(jobDate)
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: clientEmails.join(', '),
      subject: `🚚 Collection Complete - ${venueName} - ${formattedDateShort} (Ref: ${hhRef})`,
      html: generateClientCollectionConfirmationEmail(venueName, jobDate, hhRef),
    })

    console.log(`Client collection confirmation sent to ${clientEmails.join(', ')}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send client collection confirmation:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}

/**
 * Send verification code email
 */
export async function sendVerificationEmail(
  email: string,
  code: string,
  name: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
      console.error('Email configuration missing')
      return { success: false, error: 'Email service not configured' }
    }

    const transport = getTransporter()
    const firstName = name.split(' ')[0]

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">🔐 Verify Your Email</h1>
        </div>
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px;">
          <p style="font-size: 16px; margin-bottom: 20px;">Hi ${firstName},</p>
          
          <p style="font-size: 16px; margin-bottom: 20px;">
            Thanks for registering with Ooosh Tours! Please use the code below to verify your email address:
          </p>
          
          <div style="background: white; border-radius: 8px; padding: 30px; margin: 25px 0; text-align: center; border: 2px dashed #667eea;">
            <p style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #333; margin: 0;">
              ${code}
            </p>
          </div>
          
          <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
            This code will expire in 10 minutes. If you didn't request this, you can safely ignore this email.
          </p>
          
          <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
            This is an automated message from Ooosh Tours Ltd.
          </p>
        </div>
      </body>
      </html>
    `

    await transport.sendMail({
      from: FROM_ADDRESS,
      to: email,
      subject: `${code} is your Ooosh verification code`,
      html,
    })

    console.log(`Verification email sent to ${email}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to send verification email:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send email' 
    }
  }
}