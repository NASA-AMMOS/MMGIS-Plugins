const EQUIVALENT_UNIT_ALIASES = new Map([
    ['%', '%'],
    ['percent', '%'],
    ['percentage', '%'],
    ['m', 'm'],
    ['meter', 'm'],
    ['meters', 'm'],
    ['metre', 'm'],
    ['metres', 'm'],
    ['cm', 'cm'],
    ['centimeter', 'cm'],
    ['centimeters', 'cm'],
    ['centimetre', 'cm'],
    ['centimetres', 'cm'],
    ['mm', 'mm'],
    ['millimeter', 'mm'],
    ['millimeters', 'mm'],
    ['millimetre', 'mm'],
    ['millimetres', 'mm'],
    ['k', 'K'],
    ['kelvin', 'K'],
    ['°c', '°C'],
    ['celsius', '°C'],
    ['degrees celsius', '°C'],
])

function normalizedDifferenceUnit(value) {
    const unit = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
    if (!unit) return null
    return EQUIVALENT_UNIT_ALIASES.get(unit) || unit
}

export function compareDifferenceUnits(unitA, unitB) {
    const normalizedA = normalizedDifferenceUnit(unitA)
    const normalizedB = normalizedDifferenceUnit(unitB)
    if (!normalizedA || !normalizedB) {
        return {
            ok: false,
            code: 'DIFFERENCE_UNITS_UNVERIFIED',
            message:
                'Both layers must declare compatible display units before their values can be subtracted safely.',
            unit: null,
        }
    }
    if (normalizedA !== normalizedB) {
        return {
            ok: false,
            code: 'DIFFERENCE_UNIT_MISMATCH',
            message: `The two layers declare incompatible units (${String(
                unitA
            ).trim()} and ${String(unitB).trim()}).`,
            unit: null,
        }
    }
    return { ok: true, code: null, message: null, unit: normalizedA }
}
