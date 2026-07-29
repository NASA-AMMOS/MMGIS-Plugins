export function normalizeLayerText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function tokenize(value) {
    const normalized = normalizeLayerText(value)
    return normalized ? normalized.split(' ') : []
}

function uniqueStrings(values) {
    const seen = new Set()
    const out = []
    ;(values || []).forEach((value) => {
        const text = typeof value === 'string' ? value.trim() : ''
        if (!text) return
        const key = text.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(text)
    })
    return out
}

function levenshtein(a, b) {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i <= m; i += 1) dp[i][0] = i
    for (let j = 0; j <= n; j += 1) dp[0][j] = j
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            )
        }
    }
    return dp[m][n]
}

function fuzzyScore(queryNorm, candidateNorm) {
    if (!queryNorm || !candidateNorm) return 0
    if (queryNorm === candidateNorm) return 1
    if (candidateNorm.includes(queryNorm)) {
        return Math.max(0.8, queryNorm.length / Math.max(candidateNorm.length, 1))
    }
    if (queryNorm.includes(candidateNorm)) {
        return Math.max(0.7, candidateNorm.length / Math.max(queryNorm.length, 1))
    }
    const distance = levenshtein(queryNorm, candidateNorm)
    const maxLen = Math.max(queryNorm.length, candidateNorm.length, 1)
    return Math.max(0, 1 - distance / maxLen)
}

function collectAliases(layer) {
    const fromLayer = Array.isArray(layer.aliases)
        ? layer.aliases
        : Array.isArray(layer.normalizedAliases)
          ? layer.normalizedAliases.map((entry) =>
                entry && typeof entry.raw === 'string'
                    ? entry.raw
                    : String(entry || '')
            )
          : []
    return uniqueStrings([
        layer.displayName,
        layer.display,
        layer.name,
        layer.canonical,
        ...(fromLayer || []),
    ])
}

function buildGroupPath(layer) {
    if (typeof layer.groupPath === 'string' && layer.groupPath.trim()) {
        return layer.groupPath.trim()
    }
    if (Array.isArray(layer.groupPath)) {
        return layer.groupPath.map((value) => String(value || '').trim()).filter(Boolean).join(' > ')
    }
    if (Array.isArray(layer.group)) {
        return layer.group.map((value) => String(value || '').trim()).filter(Boolean).join(' > ')
    }
    if (typeof layer.group === 'string' && layer.group.trim()) {
        return layer.group.trim()
    }
    if (typeof layer.path === 'string' && layer.path.trim()) {
        return layer.path.trim()
    }
    return ''
}

function buildDomainText(layer, aliases) {
    const tags = Array.isArray(layer.tags)
        ? layer.tags
        : Array.isArray(layer.config?.tags)
          ? layer.config.tags
          : []
    const dataset =
        layer.datasetId ||
        layer.dataset ||
        layer.config?.datasetId ||
        layer.config?.dataset ||
        layer.config?.id ||
        ''
    const description =
        layer.description ||
        layer.config?.description ||
        layer.config?.metadata?.description ||
        ''
    const values = [
        layer.displayName,
        layer.name,
        layer.canonical,
        buildGroupPath(layer),
        dataset,
        description,
        ...tags,
        ...aliases,
    ]
    return normalizeLayerText(values.join(' '))
}

function detectDomainConstraints(fullQueryNorm) {
    const tokens = tokenize(fullQueryNorm)
    const hasSwot = tokens.includes('swot')
    const hasFreeboard = tokens.includes('freeboard')
    const hasSeaIce =
        fullQueryNorm.includes('seaice') ||
        /\bsea\s+ice\b/.test(fullQueryNorm)
    return { hasSwot, hasSeaIce, hasFreeboard }
}

function layerSatisfiesDomain(layerDomainNorm, constraints) {
    if (constraints.hasSwot && !layerDomainNorm.includes('swot')) return false
    if (constraints.hasSeaIce) {
        const hasSeaIce =
            layerDomainNorm.includes('seaice') ||
            /\bsea\s+ice\b/.test(layerDomainNorm)
        const seaIceRelaxedForSwotFreeboard =
            constraints.hasSwot && constraints.hasFreeboard
        if (!hasSeaIce && !seaIceRelaxedForSwotFreeboard) return false
    }
    return true
}

function buildCandidate(layer, queryNorm, queryTokens) {
    const aliases = collectAliases(layer)
    const aliasesNorm = aliases.map((alias) => normalizeLayerText(alias))
    const displayNorm = normalizeLayerText(layer.displayName || layer.display || '')
    const canonicalNorm = normalizeLayerText(layer.canonical || layer.name || '')
    const groupPath = buildGroupPath(layer)
    const groupPathNorm = normalizeLayerText(groupPath)
    const domainNorm = buildDomainText(layer, aliases)

    const exactDisplayOrName =
        (displayNorm && displayNorm === queryNorm) ||
        (canonicalNorm && canonicalNorm === queryNorm)
    const exactAlias =
        !exactDisplayOrName && aliasesNorm.some((alias) => alias === queryNorm)

    const layerTokens = new Set(
        tokenize(
            [displayNorm, canonicalNorm, aliasesNorm.join(' '), groupPathNorm].join(
                ' '
            )
        )
    )
    const containsAllTokens =
        !exactDisplayOrName &&
        !exactAlias &&
        queryTokens.length > 0 &&
        queryTokens.every((token) => layerTokens.has(token))

    const fuzzy = aliasesNorm.reduce((best, aliasNorm) => {
        const score = fuzzyScore(queryNorm, aliasNorm)
        return score > best ? score : best
    }, 0)

    const tier = exactDisplayOrName
        ? 4
        : exactAlias
          ? 3
          : containsAllTokens
            ? 2
            : 1

    const totalScore = tier * 100 + fuzzy

    return {
        layer,
        aliases,
        groupPath,
        exactDisplayOrName,
        exactAlias,
        containsAllTokens,
        fuzzy,
        tier,
        totalScore,
        domainNorm,
    }
}

function isAmbiguous(top, second) {
    if (!top || !second) return false
    // If the top match is low-confidence AND its fuzzy score is very low,
    // flag as ambiguous — but only when the second candidate is also close.
    if (top.tier <= 1 && top.fuzzy < 0.72) {
        // If second is also tier 1 and close in score, ambiguous.
        // But if second is much worse, the top is the clear winner.
        if (second.tier <= 1 && Math.abs(top.fuzzy - second.fuzzy) < 0.08) return true
        return false
    }
    if (top.tier !== second.tier) return false
    const delta = Math.abs(top.totalScore - second.totalScore)
    return delta < 0.06
}

export function resolveLayerSelection({
    requestedName,
    userQuery = '',
    layers = [],
}) {
    const queryNorm = normalizeLayerText(requestedName || userQuery)
    if (!queryNorm || !Array.isArray(layers) || layers.length === 0) {
        return { match: null, candidates: [] }
    }

    const fullQueryNorm = normalizeLayerText(userQuery || requestedName || '')
    const constraints = detectDomainConstraints(fullQueryNorm)
    let scoringQueryNorm = queryNorm
    if (constraints.hasSwot && constraints.hasFreeboard) {
        scoringQueryNorm = scoringQueryNorm
            .replace(/\bsea\s+ice\b/g, ' ')
            .replace(/\bseaice\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }
    const queryTokens = tokenize(scoringQueryNorm)

    const ranked = layers
        .map((layer) => buildCandidate(layer, scoringQueryNorm, queryTokens))
        .filter((candidate) =>
            layerSatisfiesDomain(candidate.domainNorm, constraints)
        )
        .sort((a, b) => b.totalScore - a.totalScore)

    if (!ranked.length) return { match: null, candidates: [] }

    const top = ranked[0]
    const second = ranked[1]
    const ambiguous = isAmbiguous(top, second)
    const topCandidates = ranked.slice(0, 3).map((candidate) => ({
        id: candidate.layer.id || candidate.layer.uuid || null,
        displayName:
            candidate.layer.displayName ||
            candidate.layer.display ||
            candidate.layer.name ||
            '',
        groupPath: candidate.groupPath || '',
        totalScore: candidate.totalScore,
        tier: candidate.tier,
    }))

    if (ambiguous) {
        // When the top candidates share the same display name (duplicate layers
        // in the config), auto-resolve instead of asking the user to choose
        // between identically-named options.
        const topName = normalizeLayerText(
            top.layer.displayName || top.layer.display || top.layer.name || ''
        )
        const secondName = normalizeLayerText(
            second.layer.displayName || second.layer.display || second.layer.name || ''
        )
        if (topName && topName === secondName) {
            // Prefer the visible layer, otherwise keep the first match.
            const pick = !top.layer.visible && second.layer.visible ? second : top
            const bestAlias = pick.aliases[0] || pick.layer.displayName || pick.layer.name
            return {
                match: {
                    original: requestedName,
                    resolved: pick.layer.displayName || pick.layer.display || pick.layer.name,
                    alias: bestAlias,
                    score: pick.fuzzy,
                    exact: pick.tier >= 3,
                    uuid: pick.layer.id || pick.layer.uuid || null,
                    visible: !!pick.layer.visible,
                    bbox: Array.isArray(pick.layer.bbox) ? pick.layer.bbox.slice() : null,
                    groupPath: pick.groupPath || '',
                    layer: pick.layer,
                },
                candidates: topCandidates,
            }
        }
        return {
            match: null,
            ambiguous: true,
            candidates: topCandidates,
        }
    }

    const bestAlias = top.aliases[0] || top.layer.displayName || top.layer.name
    return {
        match: {
            original: requestedName,
            resolved: top.layer.displayName || top.layer.display || top.layer.name,
            alias: bestAlias,
            score: top.fuzzy,
            exact: top.tier >= 3,
            uuid: top.layer.id || top.layer.uuid || null,
            visible: !!top.layer.visible,
            bbox: Array.isArray(top.layer.bbox) ? top.layer.bbox.slice() : null,
            groupPath: top.groupPath || '',
            layer: top.layer,
        },
        candidates: topCandidates,
    }
}
