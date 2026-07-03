import { useRef, useState } from 'react'

const MAX_CSV_BYTES = 5 * 1024 * 1024

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function ShopDataUpload({ password }) {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const handleFileSelected = (event) => {
    const selected = event.target.files?.[0] || null
    event.target.value = '' // allow re-selecting the same file after clearing
    setError('')
    setResult(null)
    if (!selected) return

    if (!selected.name.toLowerCase().endsWith('.csv')) {
      setError('Please choose a .csv file.')
      setFile(null)
      return
    }
    if (selected.size > MAX_CSV_BYTES) {
      setError('That file is over 5MB — please use a smaller export.')
      setFile(null)
      return
    }
    setFile(selected)
  }

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    setError('')
    setResult(null)
    try {
      const content = await readFileAsText(file)
      const response = await fetch('/api/upload-csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-app-password': password,
        },
        body: JSON.stringify({ filename: file.name, content }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to upload CSV.')
      }
      setResult(data)
      setFile(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <section id="shop-data-upload">
      <h2>Shop Data Upload</h2>
      <p className="subhead">
        Upload an Etsy Stats export, an eRank keyword export, or an EverBee keyword export
        (.csv) to add it to your shop data.
      </p>

      <div className="field">
        <label>CSV file</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileSelected}
          className="visually-hidden-input"
        />
        <div className="upload-row">
          <button
            type="button"
            className="upload-button"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose File
          </button>
          <span className="upload-filename">{file ? file.name : 'No file chosen'}</span>
        </div>
      </div>

      <button type="button" onClick={handleUpload} disabled={!file || uploading}>
        {uploading ? 'Uploading…' : 'Upload'}
      </button>

      {error && <p className="error">{error}</p>}

      {result && (
        <p className="upload-success">
          Imported {result.rowsImported} keyword row{result.rowsImported === 1 ? '' : 's'} from{' '}
          {result.source}.
        </p>
      )}
    </section>
  )
}

export default ShopDataUpload
