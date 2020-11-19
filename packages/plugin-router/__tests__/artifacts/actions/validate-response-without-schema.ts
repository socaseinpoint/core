import { ServiceRequest } from '@microfleet/core'

export default async function withoutResponseSchema(request: ServiceRequest): Promise<any> {
  if (request.params.success) {
    return {
      validResponse: true,
    }
  }

  return {
    validResponse: false,
    withAdditionalProperty: true,
  }
}

withoutResponseSchema.schema = 'validate-response'