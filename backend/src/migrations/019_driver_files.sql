-- Migration 018: Add files column to drivers table
-- Enables file uploads (licence images, DVLA codes, POAs, etc.)

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]';
