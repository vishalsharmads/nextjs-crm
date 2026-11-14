import type { Knex } from 'knex';

/**
 * Full-text indexes over what people write: activity subjects and bodies (notes, emails, calls,
 * meetings, tasks) and task comments. Searched with MATCH … AGAINST (MySQL 8.4+, no extensions),
 * which ranks by relevance; the assistant's search_text tool and MCP use them.
 */
export async function up(knex: Knex) {
  await knex.raw('ALTER TABLE activities ADD FULLTEXT INDEX ft_activities_text (subject, body)');
  await knex.raw('ALTER TABLE activity_comments ADD FULLTEXT INDEX ft_activity_comments_body (body)');
}

export async function down(knex: Knex) {
  await knex.raw('ALTER TABLE activity_comments DROP INDEX ft_activity_comments_body');
  await knex.raw('ALTER TABLE activities DROP INDEX ft_activities_text');
}
