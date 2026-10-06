# MapJobSubmit Plugin

A MMGIS plugin for submitting jobs to an OGC-compliant workflows API and visualizing inputs/outputs on the map.

## Overview

The MapJobSubmit plugin allows users to:
- Browse and select algorithms from an OGC-compliant workflows API
- Submit job parameters with interactive map selection for geographic inputs
- Track job status in real-time with automatic polling
- Visualize submitted job inputs (bounding boxes, points) on the map
- Import and view job history across sessions

## Configuration

### Required Settings

Configure the following in the MMGIS Configure UI under **Tools → MapJobSubmit**:

1. **API Base URL** (required)
   - Origin of the OGC workflows API
   - Example: `https://workflows-api.example.com`

2. **Member Information URL** (required)
   - Full URL to fetch authenticated user information
   - Must return JSON with an `id` field unique to each user
   - Example: `https://api.example.com/members/self`

### Optional Settings

3. **Account Creation URL** (optional)
   - Link shown to unauthenticated users for account creation
   - Example: `https://example.com/create-account`

4. **Poll Interval (ms)** (optional)
   - How often the tool polls job status
   - Default: 30000 (30 seconds)
   - Minimum: 500

5. **Resources/Queues Configuration** (optional)
   - Configure how job queues are provided:
     - **URL**: Fetch queues from API endpoint (e.g., `https://api.example.com/resources`)
       - API must return JSON: `{ "code": 200, "message": "...", "queues": [...] }`
       - `queues` can be array of strings: `["queue1", "queue2", "queue3"]`
       - Or array of objects: `[{ "name": "queue1", "label": "Queue 1" }, ...]`
       - Object format supports: `name`/`id` (used as value) and `label`/`name`/`id` (used as display)
     - **Comma-separated list**: Static queue names (e.g., `queue1,queue2,queue3`)
     - **Empty**: Disable queue selection entirely

## Usage

### Authentication

1. Enter your Personal Access Token (PAT) in the token field
2. Click "Connect" to authenticate
3. The tool will verify your token and fetch your user ID

### Submitting a Job

1. **Select Algorithm**: Choose from the algorithm dropdown (fetched from `/processes` endpoint)
2. **Select Version**: Choose the algorithm version
3. **Select Deployer**: Choose who deployed the algorithm
4. **Select Queue** (if enabled): Choose the compute queue
5. **Add Tag** (optional): Name your job run for easy identification
6. **Fill Parameters**: Enter or select parameter values
7. **Click "Submit Job"**: Job will be submitted and appear in the jobs list

### Map-Based Parameter Selection

The plugin automatically detects geographic parameters in algorithm definitions and provides interactive map selection.

#### Parameter Naming Requirements

For map selection to be enabled, parameter names must match these patterns (case-insensitive, ignoring spaces/hyphens/underscores):

**Bounding Box Parameters:**
- Contains any of: `bbox`, `boundingbox`, `bounding_box`
- Examples: `bbox`, `bounding_box`, `input-bbox`, `BBOX_AREA`
- Format: `[min_lon, min_lat, max_lon, max_lat]`
- Supports dateline-crossing bboxes (where `min_lon > max_lon`)

**Latitude/Longitude Combo (single field):**
- Contains both `lat` and `lon` variations
- Examples: `latlon`, `lat_lon`, `latlng`, `lat-long`, `coordinate`
- Format: `lat,lon` (comma-separated)

**Individual Latitude Fields:**
- Matches: `lat` or `latitude` (normalized)
- Examples: `lat`, `latitude`, `LAT`, `input-lat`

**Individual Longitude Fields:**
- Matches: `lon`, `lng`, or `longitude` (normalized)
- Examples: `lon`, `lng`, `longitude`, `LON`, `input-lng`

When both individual `lat` and `lon` fields are present, a single "Select Point on Map" button appears after both fields.

#### Map Selection Behavior

- **Bounding Box**: Click "Select on Map" → draw a rectangle on the map → coordinates auto-populate
- **Point (lat/lon)**: Click "Select on Map" → click location on map → coordinates auto-populate
- **Manual Entry**: You can also type coordinates directly into the fields
- **Live Preview**: As you edit coordinates manually, the map visualization updates in real-time

### Job Management

**Jobs List:**
- Shows all submitted jobs for the authenticated user
- Auto-refreshes every poll interval (default 30s)
- Filter by name or ID using the search box
- Paginated (10 jobs per page)

**Job Actions:**
- **Expand/Collapse**: Click job header to view details
- **View Inputs on Map**: Visualize the geographic inputs used for the job
- **Import Job**: Add a job by ID (useful for jobs submitted elsewhere)
- **Remove Job**: Delete job from MMGIS instance (doesn't affect the workflow API)

**Job Statuses:**
- `queued` - Job submitted and waiting
- `running` - Job is executing (shows current stage)
- `successful` - Job completed successfully
- `failed` - Job failed (shows error message)

## Endpoints

### OGC-Compliant Endpoints (Required)

These endpoints **must** be implemented by the workflows API and follow OGC standards:

1. **List Processes** (required, OGC-compliant)
   - `GET {baseUrl}/processes`
   - Returns available algorithms/processes
   - No authentication required

2. **Get Process Details** (required, OGC-compliant)
   - `GET {baseUrl}/processes/{processID}`
   - Returns input schema and process description
   - No authentication required

3. **Submit Job** (required, OGC-compliant)
   - `POST {baseUrl}/processes/{processID}/execution`
   - Requires authentication (PAT in `x-proxy-ticket` header)
   - Body: `{ queue: "...", tag: "...", inputs: {...} }`
   - Returns: `{ jobID: "..." }`

4. **Get Job Status** (required, OGC-compliant)
   - `GET {baseUrl}/jobs/{jobID}`
   - Requires authentication (PAT in `x-proxy-ticket` header)
   - Returns job status, stages, outputs, etc.

### MMGIS Backend Endpoints (Provided by MMGIS)

These endpoints are provided by the MMGIS backend and proxy requests to the workflows API:

- `GET/POST api/mapjobsubmit/*` - Proxy to workflows API
- `GET api/mapjobsubmit-history` - Fetch user's job history
- `POST api/mapjobsubmit-history` - Save new job to history
- `DELETE api/mapjobsubmit-history/{jobID}` - Remove job from history

### Non-OGC Extensions

This plugin adds the following custom extensions:

- **Personal Access Token Authentication**: Uses `x-proxy-ticket` header (not part of OGC standard)
- **Job Tagging**: Adds `tag` field to execution payload for user-friendly job naming
- **Queue Selection**: Adds `queue` field to execution payload for resource selection
- **User ID**: Integrates with external member API for multi-user job tracking

### Security

- All user inputs are sanitized to prevent XSS attacks
- Personal Access Tokens are validated before use
- Tokens are stored in memory only (not persisted)
- HTML output is escaped using standard sanitization
- MMGIS backend acts as proxy to prevent CORS issues

### Browser Compatibility

- Requires modern browser with ES6+ support
- Uses jQuery for DOM manipulation
- Integrates with Leaflet for map visualization
- Uses Leaflet Draw for bbox selection

## Development

### Adding Map Selection to New Parameter Types

To add map selection for additional parameter patterns:

1. Add pattern to `utils.js` constants (`LAT_VARIATIONS`, `LON_VARIATIONS`, `BBOX_VARIATIONS`)
2. Update detection functions in `utils.js` (`containsBboxVariation`, `containsLatLonCombo`)
3. Update form builder in `ui.js` (`buildFormFromInputs`) to handle new patterns

### Customizing Job Display

Job tiles and expanded views are rendered in `MapJobSubmitTool.js`:
- `renderJobs()` - Renders job list
- `buildExpandedSection()` - Renders expanded job details