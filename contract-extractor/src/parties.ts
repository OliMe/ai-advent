import type { JsonSchemaSpec } from '../../core/src/index.ts';

/** Реквизиты одной стороны договора. */
export interface Party {
  type: 'legal_entity' | 'individual_entrepreneur' | 'individual';
  name: string;
  inn: string;
  ogrn?: string;
  address: string;
  representative?: {
    name: string;
    position?: string;
    acting_on_basis?: string;
  };
}

/** Реквизиты сторон одного договора аренды. */
export interface ContractParties {
  landlord: Party;
  tenant: Party;
}

const PARTY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['legal_entity', 'individual_entrepreneur', 'individual'],
    },
    name: { type: 'string' },
    inn: { type: 'string' },
    ogrn: { type: 'string' },
    address: { type: 'string' },
    representative: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        position: { type: 'string' },
        acting_on_basis: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  required: ['type', 'name', 'inn', 'address'],
  additionalProperties: false,
};

const CONTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { landlord: PARTY_SCHEMA, tenant: PARTY_SCHEMA },
  required: ['landlord', 'tenant'],
  additionalProperties: false,
};

/** Корневая схема пакета: объект со списком договоров (по объекту на договор). */
export const BATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { contracts: { type: 'array', items: CONTRACT_SCHEMA } },
  required: ['contracts'],
  additionalProperties: false,
};

/** Спецификация строгой JSON-схемы для response_format. */
export const PARTIES_SCHEMA_SPEC: JsonSchemaSpec = {
  name: 'contracts',
  strict: true,
  schema: BATCH_SCHEMA,
};
