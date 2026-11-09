enum EmissionSource {
    Volume = "volume",
    Surface = "surface",
    Vertices = "vertices",
}

export type EmissionSourceValue = EmissionSource | `${EmissionSource}`;

export { EmissionSource };
