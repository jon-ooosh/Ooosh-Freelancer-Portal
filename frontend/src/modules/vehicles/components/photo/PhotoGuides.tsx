/**
 * SVG guide illustrations for each photo angle.
 * Shows a simplified van outline with the camera position indicated,
 * helping users frame their photos consistently.
 *
 * 14 angles in clockwise walk-around order:
 * Front → Front Right → Passenger Door → Interior Front → Sliding Door →
 * Interior Rear → Rear Right → Rear Doors → Rear Left → Left Panel →
 * Driver Door → Front Left → Windscreen → Dashboard
 */

import React from 'react'
import type { PhotoAngle } from '../../types/vehicle-event'

interface GuideProps {
  className?: string
}

function FrontGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van front - head-on view */}
      <path d="M80 240 L80 120 Q80 100 100 100 L300 100 Q320 100 320 120 L320 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Windscreen */}
      <path d="M110 100 L130 140 L270 140 L290 100 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      {/* Headlights */}
      <rect x="85" y="160" width="30" height="20" rx="4" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <rect x="285" y="160" width="30" height="20" rx="4" stroke="white" strokeWidth="1.5" opacity="0.5" />
      {/* Grille */}
      <rect x="140" y="155" width="120" height="30" rx="4" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Reg plate */}
      <rect x="150" y="200" width="100" height="20" rx="3" stroke="white" strokeWidth="1" opacity="0.4" />
      {/* Bumper */}
      <path d="M80 230 L320 230" stroke="white" strokeWidth="1.5" opacity="0.3" />
      {/* Camera position - directly in front */}
      <circle cx="200" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M200 272 L200 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand directly in front
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full front visible, centred, include reg plate
      </text>
    </svg>
  )
}

function FrontRightGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van body - 3/4 front-right view */}
      <path d="M320 240 L320 140 L280 100 L120 100 L80 140 L80 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      <path d="M280 100 L260 140 L140 140 L120 100 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <path d="M320 140 L320 240 L260 240 L260 140 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <ellipse cx="270" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="130" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <rect x="300" y="150" width="15" height="25" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <circle cx="350" cy="270" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M342 265 L300 220" stroke="white" strokeWidth="1" opacity="0.4" strokeDasharray="4 4" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand at front-right corner
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Capture front bumper + right side
      </text>
    </svg>
  )
}

function PassengerDoorGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van side view - passenger (right) side, front section */}
      <path d="M40 240 L40 110 Q40 90 60 90 L340 90 Q360 90 360 110 L360 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Front door highlighted */}
      <rect x="40" y="110" width="100" height="130" rx="2" stroke="white" strokeWidth="2" opacity="0.6" fill="white" fillOpacity="0.08" />
      {/* Door handle */}
      <rect x="120" y="170" width="15" height="5" rx="2" stroke="white" strokeWidth="1.5" opacity="0.5" />
      {/* Wing mirror */}
      <rect x="30" y="130" width="15" height="12" rx="2" stroke="white" strokeWidth="1" opacity="0.4" />
      {/* Window */}
      <path d="M50 110 L50 150 L130 150 L130 110 Z" stroke="white" strokeWidth="1" opacity="0.3" fill="white" fillOpacity="0.05" />
      {/* Wheels */}
      <ellipse cx="100" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="300" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      {/* Camera position */}
      <circle cx="100" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M100 272 L100 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand level with passenger door
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full door visible including mirror
      </text>
    </svg>
  )
}

function InteriorFrontGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M40 260 L40 180 Q40 160 60 160 L340 160 Q360 160 360 180 L360 260" stroke="white" strokeWidth="2" opacity="0.5" />
      <circle cx="140" cy="200" r="35" stroke="white" strokeWidth="2" opacity="0.4" />
      <circle cx="140" cy="200" r="10" stroke="white" strokeWidth="1" opacity="0.3" />
      <rect x="200" y="170" width="60" height="40" rx="4" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <rect x="190" y="230" width="30" height="25" rx="3" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M30 140 L370 140" stroke="white" strokeWidth="1" opacity="0.2" />
      <path d="M50 260 L50 240 Q50 220 80 220 L160 220 Q180 220 180 240 L180 260" stroke="white" strokeWidth="1" opacity="0.2" />
      <path d="M220 260 L220 240 Q220 220 240 220 L320 220 Q340 220 340 240 L340 260" stroke="white" strokeWidth="1" opacity="0.2" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        From rear of cab, looking forward
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Show dashboard, steering wheel, seats
      </text>
    </svg>
  )
}

function SlidingDoorGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van side view - right side, middle section */}
      <path d="M40 240 L40 110 Q40 90 60 90 L340 90 Q360 90 360 110 L360 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Sliding door highlighted */}
      <rect x="140" y="110" width="120" height="130" rx="2" stroke="white" strokeWidth="2" opacity="0.6" fill="white" fillOpacity="0.08" />
      {/* Door rail */}
      <line x1="140" y1="105" x2="260" y2="105" stroke="white" strokeWidth="1.5" opacity="0.4" />
      {/* Door handle */}
      <rect x="145" y="175" width="15" height="5" rx="2" stroke="white" strokeWidth="1.5" opacity="0.5" />
      {/* Window */}
      <path d="M150 115 L150 160 L250 160 L250 115 Z" stroke="white" strokeWidth="1" opacity="0.3" fill="white" fillOpacity="0.05" />
      {/* Wheels */}
      <ellipse cx="100" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="300" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      {/* Arrow showing sliding motion */}
      <path d="M270 105 L290 105" stroke="white" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arrowhead)" />
      {/* Camera position */}
      <circle cx="200" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M200 272 L200 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand level with sliding door
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full sliding door panel visible
      </text>
    </svg>
  )
}

function InteriorRearGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M40 60 L360 60" stroke="white" strokeWidth="1.5" opacity="0.3" />
      <path d="M40 60 L40 260" stroke="white" strokeWidth="1.5" opacity="0.3" />
      <path d="M360 60 L360 260" stroke="white" strokeWidth="1.5" opacity="0.3" />
      <path d="M40 260 L360 260" stroke="white" strokeWidth="1.5" opacity="0.3" />
      {/* Seat rows */}
      <path d="M60 180 L340 180" stroke="white" strokeWidth="1" opacity="0.2" strokeDasharray="8 4" />
      <path d="M60 220 L340 220" stroke="white" strokeWidth="1" opacity="0.2" strokeDasharray="8 4" />
      <rect x="60" y="180" width="50" height="40" rx="5" stroke="white" strokeWidth="1" opacity="0.25" />
      <rect x="120" y="180" width="50" height="40" rx="5" stroke="white" strokeWidth="1" opacity="0.25" />
      <rect x="230" y="180" width="50" height="40" rx="5" stroke="white" strokeWidth="1" opacity="0.25" />
      <rect x="290" y="180" width="50" height="40" rx="5" stroke="white" strokeWidth="1" opacity="0.25" />
      <rect x="80" y="80" width="240" height="80" rx="8" stroke="white" strokeWidth="1.5" opacity="0.3" />
      <line x1="200" y1="80" x2="200" y2="160" stroke="white" strokeWidth="1" opacity="0.2" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        From front cab, looking rearward
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Show seating area and rear doors
      </text>
    </svg>
  )
}

function RearRightGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M320 240 L320 110 L80 110 L80 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      <line x1="200" y1="110" x2="200" y2="240" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M320 110 L320 240 L260 240 L260 110 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <ellipse cx="270" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="130" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <rect x="303" y="180" width="12" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      <rect x="85" y="180" width="12" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      <circle cx="350" cy="270" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M342 265 L300 220" stroke="white" strokeWidth="1" opacity="0.4" strokeDasharray="4 4" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand at rear-right corner
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Capture rear doors + right side
      </text>
    </svg>
  )
}

function RearDoorsGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van rear - head-on view */}
      <path d="M80 240 L80 100 Q80 80 100 80 L300 80 Q320 80 320 100 L320 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Rear doors - double door split */}
      <rect x="90" y="100" width="100" height="140" rx="3" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <rect x="210" y="100" width="100" height="140" rx="3" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      {/* Door handles */}
      <rect x="178" y="170" width="8" height="20" rx="2" stroke="white" strokeWidth="1" opacity="0.4" />
      <rect x="214" y="170" width="8" height="20" rx="2" stroke="white" strokeWidth="1" opacity="0.4" />
      {/* Rear windows */}
      <rect x="100" y="110" width="80" height="50" rx="3" stroke="white" strokeWidth="1" opacity="0.3" fill="white" fillOpacity="0.03" />
      <rect x="220" y="110" width="80" height="50" rx="3" stroke="white" strokeWidth="1" opacity="0.3" fill="white" fillOpacity="0.03" />
      {/* Tail lights */}
      <rect x="82" y="180" width="15" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      <rect x="303" y="180" width="15" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      {/* Bumper */}
      <path d="M80 240 L320 240" stroke="white" strokeWidth="1.5" opacity="0.3" />
      {/* Camera position */}
      <circle cx="200" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M200 272 L200 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand directly behind
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full rear visible, both doors centred
      </text>
    </svg>
  )
}

function RearLeftGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M80 240 L80 110 L320 110 L320 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      <line x1="200" y1="110" x2="200" y2="240" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M80 110 L80 240 L140 240 L140 110 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <ellipse cx="130" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="270" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <rect x="85" y="180" width="12" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      <rect x="303" y="180" width="12" height="30" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" fill="red" fillOpacity="0.2" />
      <circle cx="50" cy="270" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M58 265 L100 220" stroke="white" strokeWidth="1" opacity="0.4" strokeDasharray="4 4" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand at rear-left corner
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Capture rear doors + left side
      </text>
    </svg>
  )
}

function LeftPanelGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van side view - left side, middle/rear section */}
      <path d="M40 240 L40 110 Q40 90 60 90 L340 90 Q360 90 360 110 L360 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Middle/rear panel highlighted (no sliding door on this side) */}
      <rect x="140" y="110" width="180" height="130" rx="2" stroke="white" strokeWidth="2" opacity="0.6" fill="white" fillOpacity="0.08" />
      {/* Solid panel - no windows typically on left side rear */}
      <rect x="150" y="115" width="60" height="50" rx="3" stroke="white" strokeWidth="1" opacity="0.2" />
      {/* Wheels */}
      <ellipse cx="100" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="300" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      {/* Camera position */}
      <circle cx="250" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M250 272 L250 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand level with left panel
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full left side panel visible
      </text>
    </svg>
  )
}

function DriverDoorGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      {/* Van side view - left side, front section */}
      <path d="M40 240 L40 110 Q40 90 60 90 L340 90 Q360 90 360 110 L360 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      {/* Driver door highlighted */}
      <rect x="40" y="110" width="100" height="130" rx="2" stroke="white" strokeWidth="2" opacity="0.6" fill="white" fillOpacity="0.08" />
      {/* Door handle */}
      <rect x="120" y="170" width="15" height="5" rx="2" stroke="white" strokeWidth="1.5" opacity="0.5" />
      {/* Wing mirror */}
      <rect x="30" y="130" width="15" height="12" rx="2" stroke="white" strokeWidth="1" opacity="0.4" />
      {/* Window */}
      <path d="M50 110 L50 150 L130 150 L130 110 Z" stroke="white" strokeWidth="1" opacity="0.3" fill="white" fillOpacity="0.05" />
      {/* Wheels */}
      <ellipse cx="100" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="300" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      {/* Camera position */}
      <circle cx="100" cy="280" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M100 272 L100 255" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand level with driver door
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full door visible including mirror
      </text>
    </svg>
  )
}

function FrontLeftGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="20" y1="260" x2="380" y2="260" stroke="white" strokeWidth="1" opacity="0.3" />
      <path d="M80 240 L80 140 L120 100 L280 100 L320 140 L320 240 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="none" />
      <path d="M120 100 L140 140 L260 140 L280 100 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <path d="M80 140 L80 240 L140 240 L140 140 Z" stroke="white" strokeWidth="1.5" opacity="0.4" fill="white" fillOpacity="0.05" />
      <ellipse cx="130" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <ellipse cx="270" cy="240" rx="25" ry="20" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <rect x="85" y="150" width="15" height="25" rx="3" stroke="white" strokeWidth="1.5" opacity="0.5" />
      <circle cx="50" cy="270" r="8" stroke="white" strokeWidth="2" opacity="0.7" />
      <path d="M58 265 L100 220" stroke="white" strokeWidth="1" opacity="0.4" strokeDasharray="4 4" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand at front-left corner
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Capture front bumper + left side
      </text>
    </svg>
  )
}

function WindscreenGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60 250 L100 60 L300 60 L340 250 Z" stroke="white" strokeWidth="2" opacity="0.5" fill="white" fillOpacity="0.05" />
      <path d="M60 250 L100 60" stroke="white" strokeWidth="3" opacity="0.4" />
      <path d="M340 250 L300 60" stroke="white" strokeWidth="3" opacity="0.4" />
      <path d="M100 60 L300 60" stroke="white" strokeWidth="2" opacity="0.4" />
      <path d="M120 230 Q200 100 280 230" stroke="white" strokeWidth="1" opacity="0.2" strokeDasharray="6 4" />
      <rect x="150" y="255" width="100" height="20" rx="3" stroke="white" strokeWidth="1" opacity="0.3" />
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Stand directly in front, close up
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Full windscreen visible, show any chips/cracks
      </text>
    </svg>
  )
}

function DashboardGuide({ className }: GuideProps) {
  return (
    <svg viewBox="0 0 400 300" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="30" y="80" width="340" height="180" rx="10" stroke="white" strokeWidth="2" opacity="0.5" />
      <circle cx="130" cy="160" r="45" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <circle cx="130" cy="160" r="30" stroke="white" strokeWidth="1" opacity="0.2" />
      <line x1="130" y1="160" x2="148" y2="130" stroke="white" strokeWidth="1.5" opacity="0.3" />
      <circle cx="260" cy="160" r="40" stroke="white" strokeWidth="1.5" opacity="0.4" />
      <circle cx="260" cy="160" r="25" stroke="white" strokeWidth="1" opacity="0.2" />
      <rect x="100" y="195" width="60" height="15" rx="2" stroke="white" strokeWidth="1" opacity="0.4" fill="white" fillOpacity="0.05" />
      <circle cx="170" cy="120" r="5" stroke="white" strokeWidth="1" opacity="0.3" />
      <circle cx="190" cy="120" r="5" stroke="white" strokeWidth="1" opacity="0.3" />
      <circle cx="210" cy="120" r="5" stroke="white" strokeWidth="1" opacity="0.3" />
      <rect x="310" y="140" width="30" height="50" rx="4" stroke="white" strokeWidth="1" opacity="0.3" />
      <text x="325" y="155" textAnchor="middle" fill="white" opacity="0.3" fontSize="8" fontFamily="sans-serif">F</text>
      <text x="325" y="185" textAnchor="middle" fill="white" opacity="0.3" fontSize="8" fontFamily="sans-serif">E</text>
      <text x="200" y="30" textAnchor="middle" fill="white" opacity="0.7" fontSize="14" fontFamily="sans-serif">
        Close-up of instrument panel
      </text>
      <text x="200" y="50" textAnchor="middle" fill="white" opacity="0.5" fontSize="12" fontFamily="sans-serif">
        Show mileage, fuel, any warning lights
      </text>
    </svg>
  )
}

/** Get the guide component for a photo angle */
export function getPhotoGuide(angle: PhotoAngle): ((props: GuideProps) => React.ReactNode) | null {
  const guides: Record<PhotoAngle, (props: GuideProps) => React.ReactNode> = {
    front: FrontGuide,
    front_right: FrontRightGuide,
    passenger_door: PassengerDoorGuide,
    interior_front: InteriorFrontGuide,
    sliding_door: SlidingDoorGuide,
    interior_rear: InteriorRearGuide,
    rear_right: RearRightGuide,
    rear_doors: RearDoorsGuide,
    rear_left: RearLeftGuide,
    left_panel: LeftPanelGuide,
    driver_door: DriverDoorGuide,
    front_left: FrontLeftGuide,
    windscreen: WindscreenGuide,
    dashboard: DashboardGuide,
  }
  return guides[angle] || null
}

/** Short instructional text for each angle */
export const PHOTO_GUIDE_TIPS: Record<PhotoAngle, string> = {
  front: 'Stand 2-3 metres away, directly in front. Full front visible and centred, include registration plate.',
  front_right: 'Stand 2-3 metres away at the front-right corner. Include the full front bumper and right side panel.',
  passenger_door: 'Stand level with the front passenger door. Full door visible including wing mirror.',
  interior_front: 'Stand at the sliding door or rear of cab. Show dashboard, steering wheel, and both front seats.',
  sliding_door: 'Stand level with the sliding door on the passenger side. Full door panel visible.',
  interior_rear: 'Stand at the cab partition looking rearward. Show the full seating area and rear doors.',
  rear_right: 'Stand 2-3 metres away at the rear-right corner. Include the full rear and right side panel.',
  rear_doors: 'Stand directly behind the van, centred. Both rear doors fully visible.',
  rear_left: 'Stand 2-3 metres away at the rear-left corner. Include the full rear and left side panel.',
  left_panel: 'Stand level with the left side panel. Full panel visible between wheel arches.',
  driver_door: 'Stand level with the driver door. Full door visible including wing mirror.',
  front_left: 'Stand 2-3 metres away at the front-left corner. Include the full front bumper and left side panel.',
  windscreen: 'Stand directly in front, closer. Full windscreen visible — show any chips or cracks clearly.',
  dashboard: 'Close-up of the instrument panel. Make sure the mileage reading and fuel gauge are clearly visible.',
}
