/**
 * Document upload & list for issue repair/insurance tracking.
 *
 * Uploads files to R2 at: issue-docs/{vehicleReg}/{issueId}/{docId}_{filename}
 * Stores metadata in the issue's repair.documents array.
 */

import { useState, useRef } from 'react'
import type { IssueDocument } from '../../types/issue'
import { apiFetch } from '../../config/api-config'
const R2_PUBLIC_URL = import.meta.env.VITE_R2_PUBLIC_URL || ''

interface IssueDocumentsProps {
  vehicleReg: string
  issueId: string
  documents: IssueDocument[]
  onDocumentsChange: (docs: IssueDocument[]) => void
  readOnly?: boolean
}

export function IssueDocuments({
  vehicleReg,
  issueId,
  documents,
  onDocumentsChange,
  readOnly = false,
}: IssueDocumentsProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [comment, setComment] = useState('')
  const [author, setAuthor] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleUpload = async (file: File) => {
    if (!comment.trim()) {
      alert('Please add a comment describing this document')
      return
    }

    setIsUploading(true)
    try {
      const docId = crypto.randomUUID().slice(0, 8)
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const key = `issue-docs/${vehicleReg}/${issueId}/${docId}_${safeFilename}`

      const formData = new FormData()
      formData.append('file', file, safeFilename)
      formData.append('key', key)

      const response = await apiFetch('/upload-photo', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`)
      }

      const url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : key

      const doc: IssueDocument = {
        id: docId,
        filename: file.name,
        r2Key: key,
        url,
        contentType: file.type,
        comment: comment.trim(),
        uploadedBy: author.trim() || 'Unknown',
        uploadedAt: new Date().toISOString(),
      }

      onDocumentsChange([...documents, doc])
      setComment('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      console.error('[IssueDocuments] Upload failed:', err)
      alert('Upload failed — please try again')
    } finally {
      setIsUploading(false)
    }
  }

  const handleRemove = (docId: string) => {
    onDocumentsChange(documents.filter(d => d.id !== docId))
  }

  const isImage = (contentType: string) =>
    contentType.startsWith('image/')

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="space-y-3">
      {/* Document list */}
      {documents.length > 0 && (
        <div className="space-y-2">
          {documents.map(doc => (
            <div key={doc.id} className="flex items-start gap-3 rounded-lg border border-gray-100 bg-white p-2">
              {/* Thumbnail or icon */}
              <div className="flex-shrink-0">
                {isImage(doc.contentType) ? (
                  <a href={doc.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={doc.url}
                      alt={doc.filename}
                      className="h-12 w-12 rounded border border-gray-200 object-cover"
                    />
                  </a>
                ) : (
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-12 w-12 items-center justify-center rounded border border-gray-200 bg-gray-50"
                  >
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </a>
                )}
              </div>

              {/* Details */}
              <div className="min-w-0 flex-1">
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-blue-600 hover:underline truncate block"
                >
                  {doc.filename}
                </a>
                <p className="text-[10px] text-gray-600 mt-0.5">{doc.comment}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {doc.uploadedBy} &middot; {formatDate(doc.uploadedAt)}
                </p>
              </div>

              {/* Remove button */}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemove(doc.id)}
                  className="flex-shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-400"
                  title="Remove document"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upload form */}
      {!readOnly && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="What is this document? (e.g. Quote from T Reeves)"
              className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs placeholder-gray-400 focus:border-blue-300 focus:outline-none"
            />
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="Your name"
              className="w-24 rounded-lg border border-gray-200 px-2 py-1.5 text-xs placeholder-gray-400 focus:border-blue-300 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
              onChange={e => {
                const file = e.target.files?.[0]
                if (file) handleUpload(file)
              }}
              className="hidden"
              id={`doc-upload-${issueId}`}
            />
            <label
              htmlFor={`doc-upload-${issueId}`}
              className={`flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium transition-colors ${
                isUploading
                  ? 'bg-gray-50 text-gray-400 cursor-wait'
                  : comment.trim()
                    ? 'text-ooosh-navy hover:border-ooosh-navy hover:bg-blue-50 cursor-pointer'
                    : 'text-gray-400 cursor-not-allowed'
              }`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {isUploading ? 'Uploading...' : 'Upload document'}
            </label>
            <span className="text-[10px] text-gray-400">Photos, PDFs, Word, Excel</span>
          </div>
        </div>
      )}
    </div>
  )
}
