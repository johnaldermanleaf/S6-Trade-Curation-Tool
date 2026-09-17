'use client'
import { useState, useRef, useEffect } from 'react'
import {
  buildCsvRows, toCsvText, csvFilename, productLinksForItem,
  WALL_ART_TYPES, PILLOW_TYPES, ALL_PRODUCT_TYPES, PRODUCT_TYPE_SLUGS, DEFAULT_TYPE_SLUGS,
} from '../lib/handoff'

const SAMPLE_BRIEF = `Project Name: The Savannah Grand Hotel
Project Type: Hotel
Design Style: Modern Southern, Coastal
Color Palette: Blues, Greens, Neutrals, Beige
Avoid: Anything too abstract, No dark imagery, No skulls
Rooms: Lobby, Guest Rooms, Restaurant, Bar, Hallways
Gallery Wall: Yes
Target Pieces: 80
Notes: Looking for a warm, welcoming feel that reflects Savannah's coastal charm. Should feel elevated but approachable.`


// Links come from the design's REAL available formats (from design_formats via
// the API), already filtered to the selected types. Each links to a genuine
// product page. Falls back to the item's native URL if availability is missing.
function ArtworkCard({ item, size = 'md', pinned = false, selected = true, onToggle = null, onPinToggle = null, productLinks = null }) {
  const [imgError, setImgError] = useState(false)
  const imgSize = size === 'sm' ? 'h-32' : 'h-48'
  // Prefer the primary offered format's own image so the thumbnail matches the
  // product being linked (e.g. show the shower-curtain image, not the design's
  // native pillow image). Falls back to the design's image.
  const thumb = (productLinks && productLinks[0] && productLinks[0].image) || item.image_url
  return (
    <div className={`card group flex flex-col relative ${pinned ? 'ring-2 ring-blue-400' : ''} ${onToggle && !selected ? 'opacity-40' : ''}`}>
      {/* PIN control (top-left): keep this piece through a Refine */}
      {onPinToggle && (
        <button
          onClick={e => { e.preventDefault(); onPinToggle(item.product_url) }}
          className={`absolute top-1 left-1 z-10 flex items-center gap-1 h-6 px-1.5 rounded-full border text-[10px] font-semibold transition-colors ${pinned ? 'bg-blue-500 border-blue-500 text-white' : 'bg-white/90 border-gray-300 text-gray-500 hover:text-blue-500 hover:border-blue-400'}`}
          title={pinned ? 'Pinned — kept when you Refine. Click to unpin.' : 'Pin — keep this piece when you Refine'}
        >
          <span>{pinned ? '\u2605' : '\u2606'}</span>
          <span>{pinned ? 'Pinned' : 'Pin'}</span>
        </button>
      )}
      {/* SELECT control (top-right): include this piece in the exported deck/CSV */}
      {onToggle && (
        <button
          onClick={e => { e.preventDefault(); onToggle(item.product_url) }}
          className={`absolute top-1 right-1 z-10 flex items-center gap-1 h-6 px-1.5 rounded-full border text-[10px] font-semibold transition-colors ${selected ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-400 text-gray-400 hover:border-gray-600'}`}
          title={selected ? 'In your deck — click to remove from the export' : 'Not in deck — click to add to the export'}
        >
          <span>{selected ? '\u2713' : '+'}</span>
          <span>{selected ? 'In deck' : 'Add'}</span>
        </button>
      )}
      <div className={`bg-gray-100 overflow-hidden ${imgSize} mt-7`}>
        {thumb && !imgError ? (
          <img
            src={thumb.startsWith('/') ? 'https://society6.com' + thumb : thumb}
            alt={item.image_alt || item.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs text-center px-2">
            {item.title}
          </div>
        )}
      </div>
      <div className="p-3 flex flex-col gap-1 flex-1">
        <div className="text-sm font-medium text-gray-800 leading-tight line-clamp-2">{item.title}</div>
        <div className="text-xs text-gray-400">{item.source_collection}</div>
        <div className="mt-auto pt-2">
          {productLinks && productLinks.length > 0 ? (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {productLinks.map(pl => (
                <a
                  key={pl.slug}
                  href={pl.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-red-600 hover:text-red-800 font-medium"
                  title={`View ${pl.label} on Society6`}
                >
                  {pl.label}
                </a>
              ))}
            </div>
          ) : (
            <a
              href={item.product_url?.startsWith('/') ? 'https://society6.com' + item.product_url : item.product_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-red-600 hover:text-red-800 font-medium"
            >
              View on Society6 {'->'}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// Small legend explaining the two per-card controls, shown above each grid.
function CardControlsLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-500 mb-3">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-blue-500 text-white text-[10px] font-semibold">{'\u2605'} Pin</span>
        keeps a piece when you <strong className="font-medium text-gray-600">Refine</strong>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-gray-900 text-white text-[10px] font-semibold">{'\u2713'} In deck</span>
        includes a piece in the <strong className="font-medium text-gray-600">exported deck / CSV</strong>
      </span>
    </div>
  )
}

function GalleryWallSet({ gwSet, selectedTypes = null }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Set {gwSet.setNumber}</span>
        {gwSet.theme && <span className="text-xs text-gray-500">{gwSet.theme}</span>}
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {(gwSet.items || []).map(item => (
          <ArtworkCard
            key={item.product_url}
            item={item}
            size="sm"
            productLinks={selectedTypes ? productLinksForItem(item, selectedTypes) : null}
          />
        ))}
      </div>
    </div>
  )
}

function BriefBadge({ label, values, danger = false }) {
  if (!values || values.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 items-start">
      <span className="text-xs text-gray-500 pt-0.5 shrink-0">{label}</span>
      {values.map(v => (
        <span key={v} className={`tag ${danger ? 'bg-red-50 text-red-600 border-red-200' : ''}`}>{v}</span>
      ))}
    </div>
  )
}

// Full-screen overlay shown during generate/refine. The stage messages are
// cosmetic (advanced on a timer, not real server progress); the last one is
// terminal so it never falsely claims completion.
function LoadingOverlay({ active, mode }) {
  const stages = mode === 'refine'
    ? ['Reading your feedback…', 'Re-scoring the catalog…', 'Curating new pieces…']
    : ['Reading the brief…', 'Scoring 64,000 designs…', 'Curating the final set…']
  const [stage, setStage] = useState(0)
  useEffect(() => {
    if (!active) { setStage(0); return }
    setStage(0)
    const id = setInterval(() => setStage(s => Math.min(s + 1, stages.length - 1)), 2500)
    return () => clearInterval(id)
  }, [active, mode])
  if (!active) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl px-8 py-7 flex flex-col items-center gap-4 max-w-xs mx-4">
        <svg className="animate-spin h-8 w-8 text-gray-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <div className="text-sm font-medium text-gray-800 text-center">
          {mode === 'refine' ? 'Refining your recommendations' : 'Curating your set'}
        </div>
        <div className="text-xs text-gray-500 text-center min-h-[1rem]">{stages[stage]}</div>
      </div>
    </div>
  )
}

export default function HomePage() {
  const [briefText, setBriefText] = useState('')
  const [moodboardUrl, setMoodboardUrl] = useState('')
  const [moodboardFile, setMoodboardFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [slidesLoading, setSlidesLoading] = useState(false)
  const [slidesResult, setSlidesResult] = useState(null)
  const [slidesError, setSlidesError] = useState(null)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareResult, setShareResult] = useState(null)
  const [shareError, setShareError] = useState(null)
  // Trade-app handoff ("Open in Trade Curation Tool" round trip)
  const [tradeBriefId, setTradeBriefId] = useState('')
  const [briefLoading, setBriefLoading] = useState(false)
  const [briefLoadError, setBriefLoadError] = useState(null)
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffResult, setHandoffResult] = useState(null)
  const [handoffError, setHandoffError] = useState(null)

  // Inbound from the trade app: /?briefId=123 pulls the brief server-side and
  // prefills the form. The brief text itself never travels in the URL.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('briefId')
    if (!id) return
    setTradeBriefId(id)
    setBriefLoading(true)
    fetch(`/api/trade-brief/${encodeURIComponent(id)}`)
      .then(async r => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error || 'Could not load the brief')
        return data
      })
      .then(data => {
        setBriefText(data.briefText || '')
        if (data.moodboardUrl) setMoodboardUrl(data.moodboardUrl)
        if (data.projectName) setDeckProjectName(data.projectName)
        setBriefLoadError(null)
      })
      .catch(e => setBriefLoadError(e.message || 'Could not load the brief'))
      .finally(() => setBriefLoading(false))
  }, [])
  const [activeTab, setActiveTab] = useState('primary')
  const fileInputRef = useRef(null)

  // Refine flow
  const [refineFeedback, setRefineFeedback] = useState('')
  const [refineHistory, setRefineHistory] = useState([])
  const [refineLoading, setRefineLoading] = useState(false)

  // Pinned items (paste-by-URL)
  const [pinnedUrlInput, setPinnedUrlInput] = useState('')
  const [pinnedUrls, setPinnedUrls] = useState([])
  const [findSimilarText, setFindSimilarText] = useState('')

  // Product types the collection is offered in (wall art on, pillows off by
  // default). Mini Art Print being unchecked also keeps it out of the pool,
  // preserving the old "exclude mini" behavior.
  const [selectedTypes, setSelectedTypes] = useState(() => new Set(DEFAULT_TYPE_SLUGS))
  const excludeMini = !selectedTypes.has('mini-art-print')
  // Native product_type values to filter the recommendation pool by.
  const selectedProductTypes = ALL_PRODUCT_TYPES.filter(t => selectedTypes.has(t.slug)).map(t => t.type)

  // How many designs are available in each product type (for the counts shown
  // next to each checkbox). Fetched once from design_formats on mount.
  const [typeCounts, setTypeCounts] = useState({})
  useEffect(() => {
    let alive = true
    fetch('/api/product-types')
      .then(r => r.json())
      .then(d => { if (alive) setTypeCounts(d.counts || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  function toggleType(slug) {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  const selectAllTypes = () => setSelectedTypes(new Set(PRODUCT_TYPE_SLUGS))
  const selectWallArtOnly = () => setSelectedTypes(new Set(WALL_ART_TYPES.map(t => t.slug)))
  const clearTypes = () => setSelectedTypes(new Set())

  // Item selection for deck
  const [selectedItems, setSelectedItems] = useState(new Set())

  function toggleItem(url) {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function initSelectedItems(data) {
    const urls = new Set([
      ...(data.primary || []).map(i => i.product_url),
      ...(data.accent || []).map(i => i.product_url),
      ...((data.galleryWallSets || []).flatMap(s => (s.items || []).map(i => i.product_url))),
    ])
    setSelectedItems(urls)
  }

  // Provider / deck settings
  const [providerName, setProviderName] = useState('')
  const [providerEmail, setProviderEmail] = useState('')
  const [providerPhone, setProviderPhone] = useState('')
  const [imagesPerSlide, setImagesPerSlide] = useState(8)
  const [deckClientName, setDeckClientName] = useState('')
  const [deckProjectName, setDeckProjectName] = useState('')
  const [deckLocation, setDeckLocation] = useState('')
  const [deckDate, setDeckDate] = useState(() => new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))
  const [deckType, setDeckType] = useState('')
  const [deckStyle, setDeckStyle] = useState('')
  const [deckPalette, setDeckPalette] = useState('')
  const [deckAvoid, setDeckAvoid] = useState('')
  const [deckRooms, setDeckRooms] = useState('')
  const [deckGalleryWall, setDeckGalleryWall] = useState(false)
  const [deckTargetPieces, setDeckTargetPieces] = useState('')
  const [deckNotes, setDeckNotes] = useState('')

  async function callRecommend({ brief, moodboardUrl, moodboardFile, refineFeedback, prevItemTitles, pinnedUrls, excludeMini, findSimilarUrls, productTypes }) {
    let options
    if (moodboardFile) {
      const fd = new FormData()
      fd.append('brief', brief)
      fd.append('moodboardUrl', moodboardUrl || '')
      fd.append('moodboard', moodboardFile)
      if (refineFeedback) fd.append('refineFeedback', refineFeedback)
      if (prevItemTitles?.length) fd.append('prevItemTitles', JSON.stringify(prevItemTitles))
      if (pinnedUrls?.length) fd.append('pinnedUrls', JSON.stringify(pinnedUrls))
      if (findSimilarUrls?.length) fd.append('findSimilarUrls', JSON.stringify(findSimilarUrls))
      if (productTypes?.length) fd.append('productTypes', JSON.stringify(productTypes))
      fd.append('excludeMini', String(excludeMini))
      options = { method: 'POST', body: fd }
    } else {
      options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, moodboardUrl, refineFeedback, prevItemTitles, pinnedUrls, excludeMini, findSimilarUrls, productTypes }),
      }
    }
    // A cold-started serverless function can exceed Netlify's ~10s limit and return
    // a 504 (an HTML gateway page, not JSON). The next request hits a now-warm
    // function and succeeds, so we transparently retry timeout-style failures.
    const MAX_ATTEMPTS = 3
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res
      try {
        res = await fetch('/api/recommend', options)
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) { await sleep(1500); continue }
        throw new Error('Could not reach the recommendation service. Please try again.')
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < MAX_ATTEMPTS) {
        await sleep(1500); continue
      }
      const text = await res.text()
      let data
      try { data = JSON.parse(text) }
      catch {
        if (attempt < MAX_ATTEMPTS) { await sleep(1500); continue }
        throw new Error('The recommendation service timed out. Please try again.')
      }
      if (!res.ok) throw new Error(data.error || 'Unknown error')
      return data
    }
    throw new Error('The recommendation service timed out. Please try again.')
  }

  async function handleGenerate(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResults(null)
    setSlidesResult(null)
    setSlidesError(null)
    setRefineHistory([])
    try {
      const findSimilarUrls = findSimilarText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 7)
      const data = await callRecommend({ brief: briefText, moodboardUrl, moodboardFile, pinnedUrls, excludeMini, findSimilarUrls, productTypes: selectedProductTypes })
      setResults(data)
      if (data.brief?.clientName) setDeckClientName(data.brief.clientName)
      if (data.brief?.projectName) setDeckProjectName(data.brief.projectName)
      if (data.brief?.location) setDeckLocation(data.brief.location)
      const b = data.brief || {}
      const joinL = (a) => Array.isArray(a) ? a.filter(Boolean).join(', ') : (a || '')
      if (b.clientName) setDeckClientName(b.clientName)
      setDeckType(b.projectType || '')
      setDeckStyle(joinL(b.styleTags))
      setDeckPalette(joinL(b.paletteTags))
      setDeckAvoid([joinL(b.avoidHard), joinL(b.avoidSoft)].filter(Boolean).join(', '))
      setDeckRooms(joinL(b.rooms))
      setDeckGalleryWall(!!b.galleryWall)
      setDeckTargetPieces(b.targetPieceCount || b.pieceCount || '')
      initSelectedItems(data)
      setActiveTab('primary')
      setTimeout(() => document.getElementById('results-section')?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleRefine() {
    if (!refineFeedback.trim() || !results) return
    setRefineLoading(true)
    setSlidesResult(null)
    setSlidesError(null)
    try {
      const currentItems = [...(results?.primary || []), ...(results?.accent || [])]
      const pinnedFromCards = currentItems
        .filter(isPinned).map(i => i.product_url).filter(Boolean)
      const mergedPinnedUrls = Array.from(new Set([...(pinnedUrls || []), ...pinnedFromCards]))
      const prevItemTitles = currentItems.filter(i => !isPinned(i)).map(i => i.title).filter(Boolean)

      const findSimilarUrls = findSimilarText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 7)
      const data = await callRecommend({
        brief: briefText, moodboardUrl, moodboardFile, refineFeedback,
        prevItemTitles, pinnedUrls: mergedPinnedUrls, excludeMini, findSimilarUrls,
        productTypes: selectedProductTypes,
      })
      setRefineHistory(h => [...h, refineFeedback])
      setRefineFeedback('')
      setResults(data)
      initSelectedItems(data)
      setActiveTab('primary')
    } catch (err) {
      setError(err.message)
    } finally {
      setRefineLoading(false)
    }
  }

  function handleAddPin() {
    const url = pinnedUrlInput.trim()
    if (!url) return
    if (!url.includes('society6.com')) {
      setError('Please enter a Society6 product URL.')
      return
    }
    setPinnedUrls(u => Array.from(new Set([...u, url])))
    setPinnedUrlInput('')
    setError(null)
  }

  function handleRemovePin(url) {
    setPinnedUrls(u => u.filter(x => x !== url))
  }

  function togglePin(url) {
    if (!url) return
    setPinnedUrls(u => (u.includes(url) ? u.filter(x => x !== url) : [...u, url]))
  }

  function isPinned(item) {
    if (item?.pinned) return true
    const url = item?.product_url || ''
    return url ? pinnedUrls.includes(url) : false
  }

  function pinAll(items) {
    const urls = (items || []).map(i => i?.product_url).filter(Boolean)
    setPinnedUrls(u => Array.from(new Set([...(u || []), ...urls])))
  }
  function unpinAll(items) {
    const toRemove = new Set((items || []).map(i => i?.product_url).filter(Boolean))
    setPinnedUrls(u => (u || []).filter(x => !toRemove.has(x)))
  }

  // Collect the pieces the rep marked "In deck", in placement order.
  // Shared by Download CSV and Send to Collection so both describe the same set.
  function selectedPayload() {
    if (!results) return null
    const keep = (arr) => (arr || []).filter(i => selectedItems.has(i.product_url))
    return {
      projectName: deckProjectName || results.brief?.projectName || '',
      primary: keep(results.primary),
      accent: keep(results.accent),
      galleryWallSets: (results.galleryWallSets || []).map(set => ({
        setNumber: set.setNumber,
        theme: set.theme || '',
        items: keep(set.items),
      })),
    }
  }

  function downloadCsv() {
    const payload = selectedPayload()
    if (!payload) return
    const rows = buildCsvRows(payload)
    if (rows.length === 0) { setSlidesError('Nothing selected to export. Select at least one item above.'); return }
    const filename = csvFilename(payload.projectName)
    const blob = new Blob(['\ufeff' + toCsvText(rows)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setSlidesError(null)
    setSlidesResult({ filename })
  }

  // Persist the selection and hand the trade app a URL to fetch. Nothing is
  // pushed into the trade app from here — it pulls, on the rep's click there.
  async function sendToCollection() {
    const payload = selectedPayload()
    if (!payload) return
    if (buildCsvRows(payload).length === 0) { setHandoffError('Nothing selected to send. Select at least one piece above.'); return }
    setHandoffLoading(true); setHandoffError(null); setHandoffResult(null)
    try {
      const res = await fetch('/api/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, briefRef: tradeBriefId || '' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send')
      setHandoffResult(data)
    } catch (e) {
      setHandoffError(e.message || 'Failed to send')
    } finally {
      setHandoffLoading(false)
    }
  }

  async function handleGenerateSlides() {
    if (!results) return
    setSlidesLoading(true)
    setSlidesResult(null)
    setSlidesError(null)
    try {
      // Deck stays one image per design; point each link at the first selected
      // product type so it lands on a format the client actually wants.
      const offeredTypes = ALL_PRODUCT_TYPES.filter(t => selectedTypes.has(t.slug)).map(t => t.label)
      const withType = (item) => {
        const links = productLinksForItem(item, selectedTypes)
        return links.length
          ? { ...item, product_url: links[0].url, source_collection: links[0].label, image_url: links[0].image || item.image_url }
          : item
      }
      const res = await fetch('/api/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: {
            ...results.brief,
            ...(deckClientName && { clientName: deckClientName }),
            ...(deckProjectName && { projectName: deckProjectName }),
            ...(deckLocation && { location: deckLocation }),
            ...(deckDate && { date: deckDate }),
            projectType: deckType,
            styleTags: deckStyle ? deckStyle.split(',').map(s => s.trim()).filter(Boolean) : [],
            paletteTags: deckPalette ? deckPalette.split(',').map(s => s.trim()).filter(Boolean) : [],
            avoidHard: deckAvoid ? deckAvoid.split(',').map(s => s.trim()).filter(Boolean) : [],
            avoidSoft: [],
            rooms: deckRooms ? deckRooms.split(',').map(s => s.trim()).filter(Boolean) : [],
            galleryWall: deckGalleryWall,
            targetPieceCount: deckTargetPieces || null,
            notes: deckNotes || '',
            productTypes: offeredTypes,
          },
          primary: (results.primary || []).filter(i => selectedItems.has(i.product_url)).map(withType),
          accent: (results.accent || []).filter(i => selectedItems.has(i.product_url)).map(withType),
          galleryWallSets: (results.galleryWallSets || []).map(s => ({
            ...s, items: (s.items || []).filter(i => selectedItems.has(i.product_url)).map(withType)
          })).filter(s => s.items.length > 0),
          providerInfo: { name: providerName, email: providerEmail, phone: providerPhone },
          imagesPerSlide,
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'Unknown error')
      const bytes = Uint8Array.from(atob(data.pptxBase64), c => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = data.filename || 'S6-Curation.pptx'
      document.body.appendChild(link); link.click(); document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setSlidesResult({ filename: data.filename })
    } catch (err) {
      setSlidesError(err.message)
    } finally {
      setSlidesLoading(false)
    }
  }

  function handleUseSample() { setBriefText(SAMPLE_BRIEF) }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (file && file.type === 'application/pdf') setMoodboardFile(file)
    else if (file) { setError('Please upload a PDF file.'); e.target.value = '' }
  }

  function handleFileClear() {
    setMoodboardFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const brief = results?.brief
  const tabCounts = {
    primary: results?.primary?.length || 0,
    accent: results?.accent?.length || 0,
    gallery: results?.galleryWallSets?.length || 0,
  }

  // Build a moodboard status note from the API's reported statuses.
  function moodboardNotes() {
    const m = results?.moodboard
    if (!m) return []
    const notes = []
    if (m.urlStatus === 'used') notes.push({ tone: 'ok', text: 'Moodboard URL read and applied to your brief.' })
    else if (m.urlStatus === 'failed') notes.push({ tone: 'warn', text: "Couldn't read your moodboard URL — results are based on the brief alone. Some sites (Pinterest, Houzz) block automated reading." })
    else if (m.urlStatus === 'empty') notes.push({ tone: 'warn', text: 'Your moodboard URL loaded but had no usable text to extract — results are based on the brief alone.' })
    if (m.pdfStatus === 'used') notes.push({ tone: 'ok', text: 'Moodboard PDF text read and applied to your brief.' })
    else if (m.pdfStatus === 'failed') notes.push({ tone: 'warn', text: "Couldn't read your moodboard PDF — results are based on the brief alone." })
    else if (m.pdfStatus === 'empty') notes.push({ tone: 'warn', text: 'Your moodboard PDF had no extractable text (likely image-only) — results are based on the brief alone.' })
    return notes
  }

  return (
    <div className="max-w-4xl mx-auto">
      <LoadingOverlay active={loading || refineLoading} mode={refineLoading ? 'refine' : 'generate'} />

      {/* -- Intake Form -- */}
      <div className="mb-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">New Curation Request</h1>
        <p className="text-gray-500 text-sm mb-6">Paste a client brief, optionally add a moodboard, and generate a curated set.</p>

        {briefLoading && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
            Loading brief from the trade app…
          </div>
        )}
        {briefLoadError && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            {briefLoadError} — paste the brief below instead.
          </div>
        )}
        {tradeBriefId && !briefLoading && !briefLoadError && (
          <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
            Brief <code className="font-mono">{tradeBriefId}</code> loaded from the trade app. Adjust anything below, then generate.
          </div>
        )}

        <form onSubmit={handleGenerate} className="space-y-4">

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-gray-700">Brief / Jotform Submission Text</label>
              <button type="button" onClick={handleUseSample} className="text-xs text-gray-400 hover:text-gray-600 underline">
                Load sample brief
              </button>
            </div>
            <textarea
              value={briefText}
              onChange={e => setBriefText(e.target.value)}
              placeholder="Paste the full client brief or Jotform response here..."
              rows={10}
              className="w-full border border-gray-300 rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1.5">
              Moodboard URL <span className="text-gray-400 font-normal">(optional — a Pinterest board, Houzz page, etc.)</span>
            </label>
            <input
              type="url"
              value={moodboardUrl}
              onChange={e => setMoodboardUrl(e.target.value)}
              placeholder="https://www.pinterest.com/..."
              className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <p className="text-xs text-gray-400 mt-1">We read the page's text and image captions to enrich the brief. Some sites block this — you'll see a note if it couldn't be read.</p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1.5">
              Moodboard PDF <span className="text-gray-400 font-normal">(optional — text is extracted to enrich the brief)</span>
            </label>
            {moodboardFile ? (
              <div className="flex items-center gap-3 border border-gray-200 rounded-lg p-3 bg-gray-50">
                <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-sm text-gray-700 flex-1 truncate">{moodboardFile.name}</span>
                <span className="text-xs text-gray-400">{(moodboardFile.size / 1024).toFixed(0)} KB</span>
                <button type="button" onClick={handleFileClear} className="text-xs text-gray-400 hover:text-red-500 underline shrink-0">Remove</button>
              </div>
            ) : (
              <label className="flex items-center gap-3 border border-dashed border-gray-300 rounded-lg p-4 cursor-pointer hover:border-gray-400 hover:bg-gray-50 transition-colors">
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span className="text-sm text-gray-500">Click to upload a moodboard PDF</span>
                <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" onChange={handleFileChange} className="hidden" />
              </label>
            )}
          </div>

          {/* Pinned items */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1.5">
              Pin Specific Items <span className="text-gray-400 font-normal">(optional — paste Society6 product URLs to force-include them)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={pinnedUrlInput}
                onChange={e => setPinnedUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddPin())}
                placeholder="https://society6.com/products/..."
                className="flex-1 border border-gray-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
              <button type="button" onClick={handleAddPin} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
                Add
              </button>
            </div>
            <p className="text-xs text-amber-600 mt-2">After adding a URL, click <strong>Generate Recommendations</strong> — pinned items are force-included at the top of the results.</p>
            {pinnedUrls.length > 0 && (
              <div className="mt-2 space-y-1">
                {pinnedUrls.map(url => (
                  <div key={url} className="flex items-center gap-2 text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
                    <span className="text-blue-500">{'\u2605'}</span>
                    <span className="flex-1 truncate">{url}</span>
                    <button type="button" onClick={() => handleRemovePin(url)} className="text-gray-400 hover:text-red-500">x</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Find Similar Art */}
          <div className="border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Find Similar Art <span className="text-gray-400 font-normal">(optional)</span></label>
            <p className="text-xs text-gray-500 mb-2">Paste up to 7 Society6 product URLs (one per line). We'll find art with a similar look and feel. Works on its own, or alongside a brief to steer the results. The pasted pieces are pinned at the top so you can see the match.</p>
            <textarea
              value={findSimilarText}
              onChange={e => setFindSimilarText(e.target.value)}
              rows={3}
              placeholder={'https://society6.com/products/...\nhttps://society6.com/products/...'}
              className="w-full border border-gray-300 rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            {findSimilarText.trim() && (
              <p className="text-xs text-gray-500 mt-1.5">
                {findSimilarText.split('\n').map(s => s.trim()).filter(Boolean).length} URL(s) entered
                {findSimilarText.split('\n').map(s => s.trim()).filter(Boolean).length > 7 && <span className="text-amber-600"> — only the first 7 will be used</span>}
              </p>
            )}
          </div>

          {/* Product types to include */}
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-gray-700">Product types to include</span>
              <div className="flex gap-3 text-xs">
                <button type="button" onClick={selectAllTypes} className="text-gray-500 hover:text-gray-800 underline">All</button>
                <button type="button" onClick={selectWallArtOnly} className="text-gray-500 hover:text-gray-800 underline">Wall art only</button>
                <button type="button" onClick={clearTypes} className="text-gray-500 hover:text-gray-800 underline">None</button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-3">Only designs available in the checked product types are shown, each linking to that product on Society6. Wall art is on by default; add pillows for clients who want them. (Mini Art Prints are excluded unless checked.)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Wall Art</div>
                <div className="flex flex-col gap-1.5">
                  {WALL_ART_TYPES.map(t => (
                    <label key={t.slug} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={selectedTypes.has(t.slug)} onChange={() => toggleType(t.slug)} className="accent-gray-900 w-4 h-4" />
                      <span>{t.label}{typeCounts[t.type] != null && <span className="text-gray-400"> ({typeCounts[t.type].toLocaleString()})</span>}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Home Goods</div>
                <div className="flex flex-col gap-1.5">
                  {PILLOW_TYPES.map(t => (
                    <label key={t.slug} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={selectedTypes.has(t.slug)} onChange={() => toggleType(t.slug)} className="accent-gray-900 w-4 h-4" />
                      <span>{t.label}{typeCounts[t.type] != null && <span className="text-gray-400"> ({typeCounts[t.type].toLocaleString()})</span>}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            {selectedTypes.size === 0 && (
              <p className="text-xs text-amber-600 mt-3">Select at least one product type, or results won't have any product links.</p>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" disabled={loading || (!briefText.trim() && !findSimilarText.trim())} className="btn-primary">
              {loading ? 'Generating...' : 'Generate Recommendations'}
            </button>
            {results && (
              <span className="text-sm text-gray-500">
                {results.totalScored} designs scored · catalog of {results.catalogSize?.toLocaleString?.() || results.catalogSize}
                {results.excludeMini && <span className="text-gray-400"> · mini prints excluded</span>}
              </span>
            )}
          </div>

        </form>
      </div>

      {/* -- Results -- */}
      {results && (
        <div id="results-section" className="space-y-8">

          {/* Moodboard status notes */}
          {moodboardNotes().length > 0 && (
            <div className="space-y-2">
              {moodboardNotes().map((n, i) => (
                <div key={i} className={`text-sm rounded-lg px-3 py-2 border ${n.tone === 'ok' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                  {n.text}
                </div>
              ))}
            </div>
          )}

          {/* Pinned-unmatched note */}
          {results.pinnedUnmatched > 0 && (
            <div className="text-sm rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-800">
              {results.pinnedUnmatched} pinned URL{results.pinnedUnmatched === 1 ? '' : 's'} didn't match a design in the catalog and {results.pinnedUnmatched === 1 ? 'was' : 'were'} skipped. Double-check the URL is a Society6 product page.
            </div>
          )}

          {/* Parsed brief summary */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-header mb-0">Parsed Brief</h2>
              {brief.parsedBy === 'claude' && (
                <span className="text-xs text-green-600 bg-green-50 border border-green-200 rounded px-2 py-0.5">AI-parsed</span>
              )}
            </div>
            {refineHistory.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {refineHistory.map((r, i) => (
                  <span key={i} className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-2 py-0.5">Refined: "{r}"</span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-base font-semibold text-gray-900">{brief.projectName || '--'}</div>
                <div className="text-sm text-gray-500 capitalize">{brief.projectType?.replace('_', ' ')}</div>
                {brief.keyThemes?.length > 0 && (
                  <div className="text-xs text-gray-500 mt-1 italic">"{brief.keyThemes.join(' · ')}"</div>
                )}
              </div>
              <div className="space-y-2">
                <BriefBadge label="Style" values={brief.styleTags} />
                <BriefBadge label="Palette" values={brief.paletteTags} />
                {brief.avoidHard?.length > 0 && <BriefBadge label="Avoid (strict)" values={brief.avoidHard} danger />}
                {brief.avoidSoft?.length > 0 && <BriefBadge label="De-emphasize" values={brief.avoidSoft} />}
              </div>
            </div>
            <div className="flex gap-4 text-sm text-gray-500 mt-3">
              {brief.galleryWall && <span>Gallery wall requested</span>}
            </div>
          </div>

          {/* Tabs */}
          <div>
            <div className="flex border-b border-gray-200 mb-6 gap-1">
              {[
                { key: 'primary', label: 'Primary Collection', count: tabCounts.primary },
                { key: 'accent', label: 'Accent & Alternates', count: tabCounts.accent },
                brief.galleryWall && { key: 'gallery', label: 'Gallery Wall Sets', count: tabCounts.gallery },
              ].filter(Boolean).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                    activeTab === tab.key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label} <span className="ml-1.5 text-xs text-gray-400">{tab.count}</span>
                </button>
              ))}
            </div>

            {activeTab === 'primary' && (
              <div>
                <CardControlsLegend />
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <p className="text-sm text-gray-500">Top {results.primary.length} pieces.</p>
                  <div className="flex gap-3 items-center">
                    <button onClick={() => pinAll(results.primary)} className="text-xs text-blue-600 hover:text-blue-800 underline">Pin all</button>
                    <button onClick={() => unpinAll(results.primary)} className="text-xs text-blue-600 hover:text-blue-800 underline">Unpin all</button>
                    <span className="text-gray-300">|</span>
                    <button onClick={() => setSelectedItems(prev => { const n = new Set(prev); results.primary.forEach(i => n.add(i.product_url)); return n })} className="text-xs text-gray-500 hover:text-gray-800 underline">Select all</button>
                    <button onClick={() => setSelectedItems(prev => { const n = new Set(prev); results.primary.forEach(i => n.delete(i.product_url)); return n })} className="text-xs text-gray-500 hover:text-gray-800 underline">Deselect all</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {results.primary.map(item => (
                    <ArtworkCard key={item.product_url} item={item} pinned={isPinned(item)} selected={selectedItems.has(item.product_url)} onToggle={toggleItem} onPinToggle={togglePin} productLinks={productLinksForItem(item, selectedTypes)} />
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'accent' && (
              <div>
                <CardControlsLegend />
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <p className="text-sm text-gray-500">Accent pieces and alternates.</p>
                  <div className="flex gap-3 items-center">
                    <button onClick={() => pinAll(results.accent)} className="text-xs text-blue-600 hover:text-blue-800 underline">Pin all</button>
                    <button onClick={() => unpinAll(results.accent)} className="text-xs text-blue-600 hover:text-blue-800 underline">Unpin all</button>
                    <span className="text-gray-300">|</span>
                    <button onClick={() => setSelectedItems(prev => { const n = new Set(prev); results.accent.forEach(i => n.add(i.product_url)); return n })} className="text-xs text-gray-500 hover:text-gray-800 underline">Select all</button>
                    <button onClick={() => setSelectedItems(prev => { const n = new Set(prev); results.accent.forEach(i => n.delete(i.product_url)); return n })} className="text-xs text-gray-500 hover:text-gray-800 underline">Deselect all</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {results.accent.map(item => (
                    <ArtworkCard key={item.product_url} item={item} pinned={isPinned(item)} selected={selectedItems.has(item.product_url)} onToggle={toggleItem} onPinToggle={togglePin} productLinks={productLinksForItem(item, selectedTypes)} />
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'gallery' && (
              <div>
                <p className="text-sm text-gray-500 mb-4">Curated gallery wall sets.</p>
                <div className="space-y-6">
                  {results.galleryWallSets.map(gwSet => (
                    <GalleryWallSet key={gwSet.setNumber} gwSet={gwSet} selectedTypes={selectedTypes} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* -- Refine results -- */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Refine These Results</h3>
            <p className="text-xs text-gray-500 mb-1">
              Tell the curator what to adjust — e.g. "more vintage, fewer landscapes" or "go darker, nothing with warm colors".
            </p>
            <p className="text-xs text-blue-600 mb-3">
              Tip: click <strong>Pin</strong> on any card to keep it. Pinned pieces stay; only unpinned slots get refreshed.
              {(() => {
                const count = [...(results?.primary || []), ...(results?.accent || [])].filter(isPinned).length
                return count > 0 ? ` (${count} pinned)` : ''
              })()}
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={refineFeedback}
                onChange={e => setRefineFeedback(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRefine()}
                placeholder="What would you like to change about these results?"
                className="flex-1 border border-gray-300 rounded-lg p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
              <button onClick={handleRefine} disabled={refineLoading || !refineFeedback.trim()} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40">
                {refineLoading ? 'Refining...' : 'Apply'}
              </button>
            </div>
          </div>

          {/* Export */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-6">
            <div className="flex items-center justify-between mb-1">
              <div className="font-semibold text-gray-900">Export</div>
              <span className="text-xs text-gray-500">{selectedItems.size} items selected</span>
            </div>
            <p className="text-sm text-gray-500 mb-4">Downloads a CSV of the pieces marked <strong>In deck</strong> — one row per product, with image, link, and details. Open in Google Sheets for thumbnail previews. Use the select control on each card to include or exclude pieces.</p>

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={downloadCsv} className="btn-primary" title="Download CSV of selected items. Open in Google Sheets for thumbnail previews.">
                Download CSV
              </button>
              <button
                onClick={sendToCollection}
                disabled={handoffLoading}
                className="btn-primary disabled:opacity-50"
                title="Save this selection and hand it to the trade app — no file to download or upload."
              >
                {handoffLoading ? 'Sending…' : 'Send to Collection'}
              </button>
            </div>

            {handoffError && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{handoffError}</div>
            )}

            {handoffResult && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="text-sm font-medium text-green-800 mb-1">
                  Sent — {handoffResult.designCount} pieces ({handoffResult.itemCount} rows)
                </div>
                <div className="text-sm text-green-700 mb-2">
                  Build <code className="font-mono">{handoffResult.id}</code>. The trade app can pull it from:
                </div>
                <div className="text-xs font-mono break-all text-green-800">{handoffResult.csvUrl}</div>
              </div>
            )}

            {slidesResult && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="text-sm font-medium text-green-800 mb-2">CSV downloaded</div>
                <div className="text-sm text-green-700">{slidesResult.filename} — check your Downloads folder.</div>
              </div>
            )}
            {slidesError && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="text-sm text-red-700">Error: {slidesError}</div>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
