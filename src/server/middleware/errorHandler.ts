/**
 * Unified error handling utilities
 */

//@C:ID=T.EH.ApiError;K=T;V=1.0;P=Custom API error class with status codes;D=API;M=Error;S=ErrorHandling
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }

  ///@C:EH.BadRequestFactory
  static badRequest(message: string) {
    return new ApiError(400, message, 'BAD_REQUEST')
  }

  ///@C:EH.NotFoundFactory
  static notFound(message: string) {
    return new ApiError(404, message, 'NOT_FOUND')
  }

  ///@C:EH.ConflictFactory
  static conflict(message: string) {
    return new ApiError(409, message, 'CONFLICT')
  }

  ///@C:EH.InternalFactory
  static internal(message: string) {
    return new ApiError(500, message, 'INTERNAL_ERROR')
  }
}

//@C:ID=F.EH.errorResponse;K=F;V=1.0;P=Convert errors to standard API responses;D=API;M=Error;S=ErrorHandling;In=unknown;Out=Response
export function errorResponse(error: unknown): Response {
  console.log("F.EH.errorResponse");
  
  ///@C:EH.HandleApiError
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.code || 'ERROR', message: error.message },
      { status: error.statusCode }
    )
  }

  ///@C:EH.HandleUnexpectedError
  console.error('[Server] Unexpected error:', error)
  return Response.json(
    { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    { status: 500 }
  )
}