# @subsquid/hasura-configuration

> [!NOTE]
> For info on migrating to v2 of the tool see [this page](https://docs.sqd.ai/sdk/resources/migrate/migrate-to-hasura-configuration-tool-v2).

A tool that configures Hasura to track all database tables that have [TypeORM models](https://docs.devsquid.net/sdk/reference/schema-file/intro/#typeorm-codegen) in [SQD indexers](https://docs.subsquid.io/sdk).

The configuration is saved to a file compatible with the standard Hasura import / export procedure ("Settings > Metadata Actions" in the web GUI). You can edit it in the GUI, export it, then apply it after it is erased (e.g. when the Hasura container is recreated).

## Usage

```bash
# 1. Install
npm i @subsquid/hasura-configuration

# 2. List available commands
npx squid-hasura-configuration --help
```

```
apply           Apply the configuration at hasura_metadata.json
regenerate      Analyze TypeORM models and generate a Hasura configuration
                at hasura_metadata.json that tracks all related tables and
                foreign key relationships
```

The `apply` command takes Hasura connection settings from environment variables:
- `HASURA_GRAPHQL_ENDPOINT` (default: `http://localhost:8080`)
- `HASURA_GRAPHQL_ADMIN_SECRET`

