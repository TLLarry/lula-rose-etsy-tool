// Shared client-side image upload rules and processing — JPEG/PNG only,
// 5MB max per file, up to MAX_IMAGES total. Used by the Listing Tool
// (src/EtsyTool.jsx) and the Listing Revamp photo upload
// (src/ListingRevamp.jsx), so both enforce identical limits with
// identical wording rather than two copies that could drift.
const MAX_IMAGES = 20
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// Validates a batch of File objects against the shared rules (type, size,
// remaining capacity given how many images are already added), returning
// both the accepted files and human-readable rejection reasons. The
// caller decides what to do with each — read accepted files as data
// URLs, show rejections as an error.
function validateImageFiles(files, currentCount) {
  const remainingSlots = MAX_IMAGES - currentCount
  const accepted = []
  const rejections = []
  let skippedForCapacity = 0

  files.forEach((file) => {
    if (accepted.length >= remainingSlots) {
      skippedForCapacity += 1
      return
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      rejections.push(`${file.name}: only JPEG or PNG images are allowed.`)
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejections.push(`${file.name}: image is over 5MB — please use a smaller file.`)
      return
    }
    accepted.push(file)
  })

  if (skippedForCapacity > 0) {
    rejections.push(`Only ${MAX_IMAGES} images allowed — extra files were skipped.`)
  }

  return { accepted, rejections }
}

export { MAX_IMAGES, MAX_IMAGE_BYTES, ALLOWED_IMAGE_TYPES, readFileAsDataUrl, validateImageFiles }
