/**
 * Email Service
 * 
 * Sends emails via Gmail SMTP using app passwords.
 * Used for verification codes, notifications, etc.
 */

import nodemailer from 'nodemailer'

// Create reusable transporter
function createTransporter() {
  const host = process.env.EMAIL_HOST
  const port = parseInt(process.env.EMAIL_PORT || '587')
  const user = process.env.EMAIL_USER
  const pass = process.env.EMAIL_APP_PASSWORD

  if (!host || !user || !pass) {
    throw new Error('Email configuration is incomplete. Check EMAIL_HOST, EMAIL_USER, EMAIL_APP_PASSWORD.')
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  })
}

interface SendEmailOptions {
  to: string
  subject: string
  text?: string
  html?: string
}

/**
 * Send an email
 */
export async function sendEmail({ to, subject, text, html }: SendEmailOptions): Promise<void> {
  const transporter = createTransporter()
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  })
}

/**
 * Send verification code email
 */
export async function sendVerificationEmail(to: string, code: string, name?: string): Promise<void> {
  const greeting = name ? `Hi ${name}` : 'Hi'
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #0ea5e9; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Ooosh Tours</h1>
      </div>
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #333;">${greeting},</p>
        <p style="font-size: 16px; color: #333;">Your verification code for the Ooosh Freelancer Portal is:</p>
        <div style="background-color: #f3f4f6; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #0ea5e9;">${code}</span>
        </div>
        <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
        <p style="font-size: 14px; color: #666;">If you didn't request this code, you can safely ignore this email.</p>
      </div>
      <div style="padding: 20px; background-color: #f9fafb; text-align: center;">
        <p style="font-size: 12px; color: #999; margin: 0;">Ooosh Tours Ltd</p>
      </div>
    </div>
  `

  const text = `${greeting},

Your verification code for the Ooosh Freelancer Portal is: ${code}

This code expires in 15 minutes.

If you didn't request this code, you can safely ignore this email.

Ooosh Tours`

  await sendEmail({
    to,
    subject: `${code} - Your Ooosh verification code`,
    text,
    html,
  })
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(to: string, resetLink: string, name?: string): Promise<void> {
  const greeting = name ? `Hi ${name}` : 'Hi'

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #0ea5e9; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Ooosh Tours</h1>
      </div>
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #333;">${greeting},</p>
        <p style="font-size: 16px; color: #333;">We received a request to reset your password for the Ooosh Freelancer Portal.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #0ea5e9; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
        </div>
        <p style="font-size: 14px; color: #666;">This link expires in 1 hour.</p>
        <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
      <div style="padding: 20px; background-color: #f9fafb; text-align: center;">
        <p style="font-size: 12px; color: #999; margin: 0;">Ooosh Tours Ltd</p>
      </div>
    </div>
  `

  const text = `${greeting},

We received a request to reset your password for the Ooosh Freelancer Portal.

Reset your password: ${resetLink}

This link expires in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

Ooosh Tours`

  await sendEmail({
    to,
    subject: 'Reset your Ooosh password',
    text,
    html,
  })
}

/**
 * Send new job notification email
 */
export async function sendNewJobNotification(
  to: string, 
  jobDetails: {
    venue: string
    date: string
    time?: string
    type: 'delivery' | 'collection'
    fee?: number
  },
  name?: string
): Promise<void> {
  const greeting = name ? `Hi ${name}` : 'Hi'
  const portalUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
  const typeEmoji = jobDetails.type === 'delivery' ? '📦' : '🚚'
  const typeText = jobDetails.type === 'delivery' ? 'Delivery' : 'Collection'

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #0ea5e9; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Ooosh Tours</h1>
      </div>
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #333;">${greeting},</p>
        <p style="font-size: 16px; color: #333;">You've been assigned a new job:</p>
        <div style="background-color: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
          <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: bold;">${typeEmoji} ${typeText} - ${jobDetails.venue}</p>
          <p style="margin: 0 0 5px 0; color: #666;">📅 ${jobDetails.date}${jobDetails.time ? ` at ${jobDetails.time}` : ''}</p>
          ${jobDetails.fee ? `<p style="margin: 0; color: #059669; font-weight: bold;">💷 £${jobDetails.fee} agreed</p>` : ''}
        </div>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${portalUrl}/dashboard" style="background-color: #0ea5e9; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">View in Portal</a>
        </div>
      </div>
      <div style="padding: 20px; background-color: #f9fafb; text-align: center;">
        <p style="font-size: 12px; color: #999; margin: 0;">Ooosh Tours Ltd</p>
      </div>
    </div>
  `

  const text = `${greeting},

You've been assigned a new job:

${typeText} - ${jobDetails.venue}
${jobDetails.date}${jobDetails.time ? ` at ${jobDetails.time}` : ''}
${jobDetails.fee ? `£${jobDetails.fee} agreed` : ''}

View details: ${portalUrl}/dashboard

Ooosh Tours`

  await sendEmail({
    to,
    subject: `New job from Ooosh! ${typeEmoji} ${typeText} - ${jobDetails.venue}`,
    text,
    html,
  })
}

/**
 * Send job cancelled notification
 */
export async function sendJobCancelledNotification(
  to: string,
  jobDetails: {
    venue: string
    date: string
    type: 'delivery' | 'collection'
  },
  name?: string
): Promise<void> {
  const greeting = name ? `Hi ${name}` : 'Hi'
  const typeText = jobDetails.type === 'delivery' ? 'Delivery' : 'Collection'

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #ef4444; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Job Cancelled</h1>
      </div>
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #333;">${greeting},</p>
        <p style="font-size: 16px; color: #333;">The following job has been cancelled:</p>
        <div style="background-color: #fef2f2; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #ef4444;">
          <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: bold; text-decoration: line-through; color: #666;">${typeText} - ${jobDetails.venue}</p>
          <p style="margin: 0; color: #666;">📅 ${jobDetails.date}</p>
        </div>
        <p style="font-size: 14px; color: #666;">If you have any questions, please get in touch.</p>
      </div>
      <div style="padding: 20px; background-color: #f9fafb; text-align: center;">
        <p style="font-size: 12px; color: #999; margin: 0;">Ooosh Tours Ltd</p>
      </div>
    </div>
  `

  const text = `${greeting},

The following job has been cancelled:

${typeText} - ${jobDetails.venue}
${jobDetails.date}

If you have any questions, please get in touch.

Ooosh Tours`

  await sendEmail({
    to,
    subject: `Job cancelled - ${jobDetails.venue}`,
    text,
    html,
  })
}
