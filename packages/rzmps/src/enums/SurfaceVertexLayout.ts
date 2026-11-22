/** Vertex addressing supplied by a custom liquid-surface extraction method. */
export enum SurfaceVertexLayout {
  /** Three consecutive vertices per triangle; the default for custom extractors. */
  Triangles = 'Triangles',
  /** One vertex address per sparse cell, including cells without generated surface geometry. */
  Cells = 'Cells',
  /** Compact vertices addressed through vertexMap; zero map entries identify absent vertices. */
  Compact = 'Compact',
}
