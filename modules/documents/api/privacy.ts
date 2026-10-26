import { AppError, type ErasureResult, type PrivacyHandler } from '@app/api/module-api';

export const documentsPrivacy: PrivacyHandler = {
  key: 'documents',
  tables: ['m_documents_documents', 'm_documents_requests'],
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const documents = await conn('m_documents_documents')
      .where({ contact_id: subject.id })
      .orderBy('id')
      .select('title', 'status', 'signed_name', 'signed_ip', 'signed_at', 'created_at');
    const requests = await conn('m_documents_requests')
      .where({ contact_id: subject.id })
      .orderBy('id')
      .select('description', 'status', 'review_note', 'created_at');
    return { documents, requests };
  },
  async erase(subject, trx, mode): Promise<ErasureResult> {
    if (subject.entity !== 'contact') return {};
    const signed = Number(
      (
        (await trx('m_documents_documents')
          .where({ contact_id: subject.id, status: 'signed' })
          .count({ c: '*' })
          .first()) as { c: number }
      ).c,
    );
    if (mode === 'delete') {
      // Deleting the contact would cascade to signed documents, which are evidence of an agreement.
      if (signed)
        throw new AppError(
          'CONFLICT',
          `This person has ${signed} signed document(s) that must be kept. Anonymize the record instead.`,
        );
      const requests = await trx('m_documents_requests').where({ contact_id: subject.id }).delete();
      const documents = await trx('m_documents_documents').where({ contact_id: subject.id }).delete();
      return { cleared: { documents, requests } };
    }
    const requests = await trx('m_documents_requests')
      .where({ contact_id: subject.id })
      .update({ review_note: null });
    return {
      cleared: { requests },
      retained: signed
        ? [{ area: 'documents', reason: `${signed} signed document(s) kept as evidence of the agreement` }]
        : [],
    };
  },
};
