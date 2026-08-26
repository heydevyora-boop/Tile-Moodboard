/**
 * Reusable OpenAPI 3.0 component schemas. Every path definition in
 * src/docs/paths/*.ts references these via $ref rather than repeating
 * field lists — keeps the spec consistent with the actual Prisma schema
 * and easy to update in one place when a model changes.
 */
export const schemas = {
  ErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      status: { type: 'string', example: 'fail' },
      message: { type: 'string', example: 'A human-readable description of what went wrong.' },
    },
    required: ['success', 'status', 'message'],
  },
  ValidationErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      status: { type: 'string', example: 'fail' },
      message: { type: 'string', example: 'Validation failed' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', example: 'email' }, message: { type: 'string', example: 'Invalid email address' } },
        },
      },
    },
  },
  PaginationMeta: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 20 },
      total: { type: 'integer', example: 57 },
      totalPages: { type: 'integer', example: 3 },
    },
  },
  Role: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'clx1role001' },
      name: { type: 'string', enum: ['OWNER', 'ADMIN', 'STAFF'], example: 'STAFF' },
      permissions: { type: 'array', items: { type: 'string' }, example: ['customers:read', 'customers:write'] },
    },
  },
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'clx1user001' },
      name: { type: 'string', example: 'Priya Deshmukh' },
      email: { type: 'string', format: 'email', example: 'priya@casadeaurum.com' },
      isActive: { type: 'boolean', example: true },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      role: { $ref: '#/components/schemas/Role' },
    },
  },
  AuthTokens: {
    type: 'object',
    properties: {
      accessToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
      expiresIn: { type: 'integer', example: 900, description: 'Access token lifetime in seconds' },
    },
  },
  Customer: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'clx1cust001' },
      name: { type: 'string', example: 'Anita Kulkarni' },
      phone: { type: 'string', nullable: true, example: '9876543210' },
      email: { type: 'string', nullable: true, example: 'anita@example.com' },
      preferredStyle: { type: 'string', nullable: true, example: 'LUXURY' },
      preferredRoom: { type: 'string', nullable: true, example: 'BATHROOM' },
      budget: { type: 'string', nullable: true, example: '2-3 Lakh' },
      notes: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  CustomerFavorite: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tileId: { type: 'string' },
      note: { type: 'string', nullable: true, example: 'Loved this on her last visit' },
      tile: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string', example: 'Ivory Stone Base' }, brand: { type: 'object', properties: { name: { type: 'string', example: 'Somany' } } } },
      },
    },
  },
  Tile: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string', example: 'Ivory Stone Base' },
      type: { type: 'string', enum: ['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE'] },
      size: { type: 'string', example: '600x1200mm' },
      finish: { type: 'string', example: 'Matt' },
      colorTone: { type: 'string', example: 'Warm Beige' },
      imageUrl: { type: 'string' },
      brand: { type: 'object', properties: { name: { type: 'string' } } },
    },
  },
  Catalog: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      fileName: { type: 'string', example: 'somany_catalog_2026.pdf' },
      status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] },
      totalPages: { type: 'integer', nullable: true },
      currentPage: { type: 'integer', nullable: true },
      tilesExtracted: { type: 'integer', example: 42 },
      duplicateImagesSkipped: { type: 'integer' },
      duplicateTilesSkipped: { type: 'integer' },
      errorMessage: { type: 'string', nullable: true },
      queuePosition: { type: 'integer', nullable: true, description: 'Position in the extraction queue, only meaningful while status is PENDING' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  DesignRule: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      section: { type: 'string', enum: ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'] },
      title: { type: 'string' },
      content: { type: 'string' },
      status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
      version: { type: 'integer' },
    },
  },
  ReferenceImage: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      styleTag: { type: 'string', example: 'luxury_bathroom_01' },
      style: { type: 'string', nullable: true, example: 'LUXURY' },
      room: { type: 'string', nullable: true, example: 'BATHROOM' },
      description: { type: 'string', nullable: true },
      imageUrl: { type: 'string' },
      thumbnailUrl: { type: 'string', nullable: true, description: 'Populated asynchronously by the Image Processing Queue shortly after upload' },
    },
  },
  MoodBoardCombination: {
    type: 'object',
    properties: {
      board_name: { type: 'string', example: 'Warm Minimal Bathroom' },
      tiles: { type: 'array', items: { type: 'object', properties: { tileId: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', enum: ['base', 'highlight', 'border', 'accent'] }, imageUrl: { type: 'string' }, pricePerSqft: { type: 'number' } } } },
      grout_recommendation: { type: 'string', example: 'Warm grey grout, 2mm joint' },
      rooms_suitable: { type: 'array', items: { type: 'string' } },
      reason_for_selection: { type: 'string' },
    },
  },
  MoodBoard: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      clientBrief: { type: 'string' },
      style: { type: 'string', example: 'LUXURY' },
      room: { type: 'string', example: 'BATHROOM' },
      status: { type: 'string', enum: ['DRAFT', 'GENERATED', 'REFINED', 'APPROVED', 'REJECTED', 'ARCHIVED'] },
      selectedIndex: { type: 'integer', nullable: true },
      combinations: { type: 'array', items: { $ref: '#/components/schemas/MoodBoardCombination' } },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  PrintBoard: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      format: { type: 'string', enum: ['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM'] },
      layout: { type: 'string', enum: ['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE'] },
      widthValue: { type: 'number' },
      heightValue: { type: 'number' },
      unit: { type: 'string', enum: ['FT', 'IN', 'CM', 'MM'] },
      dpi: { type: 'integer', example: 300 },
      fileFormat: { type: 'string', enum: ['PNG', 'PDF'] },
      fileUrl: { type: 'string', nullable: true },
      driveShareUrl: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  ApiKey: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      service: { type: 'string', enum: ['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM'] },
      label: { type: 'string', example: 'Primary Gemini Key' },
      maskedValue: { type: 'string', example: 'AIza...9fX2', description: 'The real value is encrypted at rest and never returned in full via the API' },
      isActive: { type: 'boolean' },
      lastRotatedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  Job: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['IMAGE_PROCESSING', 'EXPORT'] },
      status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] },
      result: { type: 'object', nullable: true },
      error: { type: 'string', nullable: true },
      attempts: { type: 'integer' },
      maxAttempts: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  ActivityLog: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      action: { type: 'string', example: 'mood_board.approved' },
      entityType: { type: 'string', nullable: true, example: 'MoodBoard' },
      entityId: { type: 'string', nullable: true },
      user: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  LoginAttempt: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      success: { type: 'boolean' },
      failureReason: { type: 'string', nullable: true, example: 'invalid_password' },
      ipAddress: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  ErrorLog: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      message: { type: 'string' },
      statusCode: { type: 'integer', example: 500 },
      method: { type: 'string', example: 'POST' },
      path: { type: 'string', example: '/api/v1/mood-boards/generate' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
};
