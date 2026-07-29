// Time Series Animation Functions for MMGIS Copilot
// Provides temporal animation capabilities for visualizing changes over time

import { 
    buildLayerIndex, 
    findLayerMatch,
    resolveArea
} from './rendererUtils.js'

// Escape untrusted strings before interpolating them into innerHTML. Layer
// names originate from agent tool actions, so they must never be treated as
// markup.
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// Animation state management
const animationState = {
    isPlaying: false,
    currentFrame: 0,
    totalFrames: 0,
    frameRate: 1000, // milliseconds per frame
    timePoints: [],
    layerName: null,
    animationTimer: null,
    loopMode: 'once' // 'once', 'loop', 'bounce'
}

/**
 * Infer the animation interval from a layer's time format or name.
 * Returns 'daily', 'monthly', 'yearly', or 'hourly'.
 */
function inferInterval(layerConfig, displayName) {
    // Check the layer name / display name for explicit keywords
    const nameLower = (displayName || layerConfig.name || '').toLowerCase()
    if (/\bhourly\b/.test(nameLower)) return 'hourly'
    if (/\bdaily\b/.test(nameLower)) return 'daily'
    if (/\bweekly\b/.test(nameLower)) return 'weekly'
    if (/\bmonthly\b/.test(nameLower)) return 'monthly'
    if (/\byearly\b|\bannual\b/.test(nameLower)) return 'yearly'

    // Infer from the time format string
    const fmt = (layerConfig.time?.format || '').trim()
    if (fmt) {
        if (/%H|%M|%S/.test(fmt) && /%d/.test(fmt)) return 'hourly'
        if (/%d/.test(fmt)) return 'daily'
        if (/%m/.test(fmt) && !/%d/.test(fmt)) return 'monthly'
        if (/%Y/.test(fmt) && !/%m/.test(fmt)) return 'yearly'
    }

    return 'daily'
}

/**
 * Create time series animation for a layer
 */
export async function createTimeSeriesAnimation(layerName, options = {}) {
    // Find the layer first so we can use its config for defaults
    const layerMatch = findLayerMatch(layerName)
    if (!layerMatch) {
        throw new Error(`Layer "${layerName}" not found`)
    }

    const layerConfig = layerMatch.layer?.config || {}
    const timeConfig = layerConfig.time || {}

    // Infer interval from layer time format or name when not explicitly provided
    const inferredInterval = inferInterval(layerConfig, layerMatch.displayName)

    // Infer time range from layer's availableStart/End
    const inferredStart = timeConfig.availableStart
        ? timeConfig.availableStart.split('T')[0]
        : null
    const inferredEnd = timeConfig.availableEnd
        ? timeConfig.availableEnd.split('T')[0]
        : null

    const {
        startTime = inferredStart || '2024-01-01',
        endTime = inferredEnd || '2024-12-31',
        interval = inferredInterval,
        frameRate = 1000,
        loopMode = 'loop',
        area = null
    } = options

    // Generate time points
    const timePoints = generateAnimationFrames(startTime, endTime, interval)
    if (timePoints.length < 2) {
        throw new Error('Animation requires at least 2 time points')
    }
    
    // Initialize animation state
    animationState.layerName = layerMatch.displayName
    animationState.timePoints = timePoints
    animationState.totalFrames = timePoints.length
    animationState.currentFrame = 0
    animationState.frameRate = frameRate
    animationState.loopMode = loopMode
    animationState.isPlaying = false
    animationState._layerEnsured = false
    
    // Set up animation controls
    const controls = {
        play: () => startAnimation(),
        pause: () => pauseAnimation(),
        stop: () => stopAnimation(),
        nextFrame: () => showNextFrame(),
        previousFrame: () => showPreviousFrame(),
        setFrame: (index) => showFrame(index),
        setSpeed: (rate) => setAnimationSpeed(rate),
        exportFrames: () => exportAnimationFrames()
    }
    
    // Create and append the animation UI controls
    createAnimationUI(controls)
    
    return {
        layerName: layerMatch.displayName,
        startTime,
        endTime,
        interval,
        totalFrames: timePoints.length,
        frameRate,
        timePoints,
        controls,
        status: 'ready'
    }
}

/**
 * Generate animation frame time points
 */
function generateAnimationFrames(startTime, endTime, interval) {
    const start = new Date(startTime)
    const end = new Date(endTime)
    const frames = []
    
    let current = new Date(start)
    
    while (current <= end) {
        frames.push({
            timestamp: current.toISOString(),
            date: current.toISOString().split('T')[0],
            label: formatTimeLabel(current, interval)
        })
        
        // Increment based on interval
        switch (interval) {
            case 'daily':
                current.setDate(current.getDate() + 1)
                break
            case 'weekly':
                current.setDate(current.getDate() + 7)
                break
            case 'monthly':
                current.setMonth(current.getMonth() + 1)
                break
            case 'quarterly':
                current.setMonth(current.getMonth() + 3)
                break
            case 'yearly':
                current.setFullYear(current.getFullYear() + 1)
                break
            case 'hourly':
                current.setHours(current.getHours() + 1)
                break
            default:
                current.setMonth(current.getMonth() + 1)
        }
    }
    
    return frames
}

/**
 * Format time label for display
 */
function formatTimeLabel(date, interval) {
    const options = {
        'hourly': { hour: '2-digit', day: 'numeric', month: 'short' },
        'daily': { day: 'numeric', month: 'short', year: 'numeric' },
        'weekly': { day: 'numeric', month: 'short', year: 'numeric' },
        'monthly': { month: 'long', year: 'numeric' },
        'quarterly': { month: 'short', year: 'numeric' },
        'yearly': { year: 'numeric' }
    }
    
    return date.toLocaleDateString('en-US', options[interval] || options.monthly)
}

/**
 * Start the animation
 */
function startAnimation() {
    if (animationState.isPlaying) return

    animationState.isPlaying = true

    // Show the current frame immediately so there is no blank delay
    showFrame(animationState.currentFrame)

    animationState.animationTimer = setInterval(() => {
        const cur = animationState.currentFrame

        if (cur >= animationState.totalFrames - 1) {
            // Reached the last frame
            if (animationState.loopMode === 'once') {
                pauseAnimation()
                return
            }
            // loop — wrap back to frame 0
            showFrame(0)
        } else {
            showFrame(cur + 1)
        }
    }, animationState.frameRate)

    return { status: 'playing' }
}

/**
 * Pause the animation
 */
function pauseAnimation() {
    if (!animationState.isPlaying) return
    
    animationState.isPlaying = false
    if (animationState.animationTimer) {
        clearInterval(animationState.animationTimer)
        animationState.animationTimer = null
    }
    
    return { status: 'paused', currentFrame: animationState.currentFrame }
}

/**
 * Stop the animation and reset
 */
function stopAnimation() {
    pauseAnimation()
    animationState.currentFrame = 0
    showFrame(0)
    
    return { status: 'stopped' }
}

/**
 * Show the next frame
 */
function showNextFrame() {
    const nextFrame = (animationState.currentFrame + 1) % animationState.totalFrames
    showFrame(nextFrame)
}

/**
 * Show the previous frame
 */
function showPreviousFrame() {
    const prevFrame = animationState.currentFrame - 1
    showFrame(prevFrame < 0 ? animationState.totalFrames - 1 : prevFrame)
}

/**
 * Ensure the animation target layer is visible on the map.
 * reloadLayer only refreshes tiles when the layer is ON, so we
 * must toggle it on before the first frame.
 */
async function ensureLayerOn(layerName) {
    if (!window.mmgisAPI) return
    const api = window.mmgisAPI
    // getVisibleLayers returns an object keyed by layer name/UUID
    const visible = api.getVisibleLayers?.() || {}
    if (!visible[layerName]) {
        // toggleLayer(name, true) turns the layer on
        await api.toggleLayer?.(layerName, true)
    }
}

/**
 * Show a specific frame
 */
async function showFrame(index) {
    if (index < 0 || index >= animationState.totalFrames) return

    animationState.currentFrame = index
    const frame = animationState.timePoints[index]

    const api = window.mmgisAPI
    if (api) {
        // Ensure the target layer is visible on the map
        if (!animationState._layerEnsured) {
            const layerIndex = buildLayerIndex()
            const layer = layerIndex.find(l => l.displayName === animationState.layerName)
            if (layer) {
                await ensureLayerOn(layer.name)
                animationState._layerEnsured = true
            }
        }

        // Use the global setTime API — this updates the TimeControl UI,
        // sets all layer times, and reloads every time-enabled layer.
        if (api.setTime) {
            api.setTime(
                frame.timestamp,    // startTime
                frame.timestamp,    // endTime
                false,              // isRelative
                '00:00:00',         // timeOffset
                frame.timestamp     // currentTime
            )
        }
    }

    // Update animation display
    updateAnimationDisplay(frame, index)
}

/**
 * Create animation UI controls
 */
function createAnimationUI(controls) {
    // Store controls globally for access from DOM
    window.mmgisAnimationControls = controls
    
    // Create animation control panel
    const controlPanel = getOrCreateAnimationOverlay()
    updateAnimationControlPanel(controlPanel, controls)
}

/**
 * Get or create animation overlay
 */
function getOrCreateAnimationOverlay() {
    let overlay = document.getElementById('mmgis-animation-overlay')
    
    if (!overlay) {
        overlay = document.createElement('div')
        overlay.id = 'mmgis-animation-overlay'
        overlay.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 10000;
            background: rgba(0,0,0,0.9);
            color: white;
            padding: 15px;
            border-radius: 8px;
            font-family: Arial, sans-serif;
            font-size: 14px;
            min-width: 280px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `
        document.body.appendChild(overlay)
    }
    
    return overlay
}

/**
 * Update animation control panel
 */
function updateAnimationControlPanel(panel, controls) {
    const frame = animationState.timePoints[animationState.currentFrame]
    const isPlaying = animationState.isPlaying
    
    panel.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">Time Series Animation</div>
        <div style="margin-bottom: 8px;">Layer: ${escapeHtml(animationState.layerName)}</div>
        <div style="margin-bottom: 8px;">Frame: ${animationState.currentFrame + 1} / ${animationState.totalFrames}</div>
        <div style="margin-bottom: 8px;">Time: ${frame ? escapeHtml(frame.label) : 'Loading...'}</div>
        <div style="margin-bottom: 12px;">Status: ${isPlaying ? 'Playing' : 'Ready'}</div>
        
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
            <button onclick="window.mmgisAnimationControls.play()" 
                    style="padding: 6px 12px; background: #22c55e; color: white; border: none; border-radius: 4px; cursor: pointer;"
                    ${isPlaying ? 'disabled' : ''}>
                ${isPlaying ? '▶ Playing' : '▶ Play'}
            </button>
            <button onclick="window.mmgisAnimationControls.pause()" 
                    style="padding: 6px 12px; background: #f59e0b; color: white; border: none; border-radius: 4px; cursor: pointer;"
                    ${!isPlaying ? 'disabled' : ''}>
                ⏸ Pause
            </button>
            <button onclick="window.mmgisAnimationControls.stop()" 
                    style="padding: 6px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer;">
                ⏹ Stop
            </button>
        </div>
        
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
            <button onclick="window.mmgisAnimationControls.previousFrame()" 
                    style="padding: 6px 12px; background: #6b7280; color: white; border: none; border-radius: 4px; cursor: pointer;">
                ⏮ Prev
            </button>
            <button onclick="window.mmgisAnimationControls.nextFrame()" 
                    style="padding: 6px 12px; background: #6b7280; color: white; border: none; border-radius: 4px; cursor: pointer;">
                ⏭ Next
            </button>
        </div>
        
        <div style="margin-top: 10px;">
            <label style="display: block; margin-bottom: 4px;">Speed (ms/frame):</label>
            <input type="range" min="200" max="3000" value="${animationState.frameRate}" 
                   onchange="window.mmgisAnimationControls.setSpeed(this.value)"
                   style="width: 100%;"/>
            <div style="text-align: center; font-size: 12px; color: #ccc;">${animationState.frameRate}ms</div>
        </div>
        
        <button onclick="closeAnimationOverlay()" 
                style="position: absolute; top: 5px; right: 8px; background: none; border: none; color: #ccc; font-size: 18px; cursor: pointer;">
            ×
        </button>
    `
}

/**
 * Close animation overlay
 */
window.closeAnimationOverlay = function() {
    const overlay = document.getElementById('mmgis-animation-overlay')
    if (overlay) {
        overlay.remove()
    }
    // Stop animation when closing
    if (animationState.animationTimer) {
        clearInterval(animationState.animationTimer)
        animationState.animationTimer = null
        animationState.isPlaying = false
    }
}

/**
 * Update animation display information
 */
function updateAnimationDisplay(frame, index) {
    // Update the control panel
    const overlay = document.getElementById('mmgis-animation-overlay')
    if (overlay && window.mmgisAnimationControls) {
        updateAnimationControlPanel(overlay, window.mmgisAnimationControls)
    }
}

/**
 * Set animation speed
 */
function setAnimationSpeed(rate) {
    animationState.frameRate = rate
    
    if (animationState.isPlaying) {
        pauseAnimation()
        startAnimation()
    }
    
    return { frameRate: rate }
}

/**
 * Export animation frames data
 */
function exportAnimationFrames() {
    const exportData = {
        layerName: animationState.layerName,
        frames: animationState.timePoints.map((frame, index) => ({
            index,
            timestamp: frame.timestamp,
            date: frame.date,
            label: frame.label
        })),
        totalFrames: animationState.totalFrames,
        frameRate: animationState.frameRate,
        loopMode: animationState.loopMode
    }
    
    return exportData
}

/**
 * Format animation results for display
 */
export function formatAnimationResults(results) {
    const lines = []
    lines.push(`Time Series Animation Created: ${results.layerName}`)
    lines.push(`Time Range: ${results.startTime} to ${results.endTime}`)
    lines.push(`Interval: ${results.interval}`)
    lines.push(`Total Frames: ${results.totalFrames}`)
    lines.push(`Frame Rate: ${results.frameRate}ms per frame`)
    lines.push('')
    lines.push('Animation Controls:')
    lines.push('  [PLAY] - Start animation')
    lines.push('  [PAUSE] - Pause animation')
    lines.push('  [STOP] - Stop and reset')
    lines.push('  [PREV] - Previous frame')
    lines.push('  [NEXT] - Next frame')
    lines.push('')
    lines.push('Status: Ready to play')
    
    return lines.join('\n')
}

export default {
    createTimeSeriesAnimation,
    formatAnimationResults,
    startAnimation,
    pauseAnimation,
    stopAnimation,
    showNextFrame,
    showPreviousFrame,
    showFrame,
    setAnimationSpeed
}