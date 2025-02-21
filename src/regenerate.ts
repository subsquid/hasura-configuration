import assert from "assert"
import fs from "fs"
import {program} from "commander"
import inquirer from "inquirer"
import {getMetadataArgsStorage} from "typeorm"
import {MetadataArgsStorage} from "typeorm/metadata-args/MetadataArgsStorage"
import {RelationTypeInFunction} from "typeorm/metadata/types/RelationTypeInFunction"
import {PropertyTypeFactory} from "typeorm/metadata/types/PropertyTypeInFunction"
import {runProgram} from "@subsquid/util-internal"
import {toSnakeCase} from "@subsquid/util-naming"
import {registerTsNodeIfRequired, isTsNode} from "@subsquid/util-internal-ts-node"
import {CONFIG_PATH} from "./common"
import baseHasuraConfig from "./baseConfig.json"

const HASURA_GRAPHQL_UNAUTHORIZED_ROLE = process.env.HASURA_GRAPHQL_UNAUTHORIZED_ROLE ?? 'public'

runProgram(async () => {
    program.description(`Analyze TypeORM models and generate a Hasura configuration at ${CONFIG_PATH} that tracks all related tables and foreign key relationships`)
    program.option('-f, --force', `do not prompt before overwriting ${CONFIG_PATH}`, false)

    const {force} = program.parse().opts() as {force: boolean}

    await registerTsNodeIfRequired()

    validateBaseConfig(baseHasuraConfig)

    // Required for getMetadataArgsStorage() to work
    const modelPath =
        isTsNode() ?
        `${process.cwd()}/src/model/index.ts` :
        `${process.cwd()}/lib/model/index.js`
    // @ts-ignore
    const model = await import(modelPath)

    const typeormMetadata: MetadataArgsStorage = getMetadataArgsStorage()

    const tables: string[] = getTablesData(typeormMetadata)
    const relationships: RelationshipRecord[] = getRelationshipsData(typeormMetadata)

    let hasuraTables = makeHasuraTablesConfig(tables)
    hasuraTables = updateHasuraTablesWithRelationshipsConfig(hasuraTables, relationships)
    hasuraTables = updateHasuraTablesWithPermissionsConfig(hasuraTables)

    let hasuraConfig = baseHasuraConfig as any
    try {
        hasuraConfig.metadata.sources[0].tables = hasuraTables
    }
    catch (e) {
        console.error(`Failed to assign the generated config to the default config field`, e)
        process.exit(1)
    }

    if (fs.existsSync(CONFIG_PATH) && !force) {
        const { confirm } = await inquirer.prompt([
            {
                name: 'confirm',
                type: 'confirm',
                message: `Hasura config file ${CONFIG_PATH} exists. Do you want to overwrite it?`,
                default: false
            }
        ])
        if (!confirm) process.exit(0)
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(hasuraConfig, null, '  '))
})


function validateBaseConfig(config: any): void {
    assert(config.metadata !== undefined, `Base config must have a "metadata" field`)
    assert(Array.isArray(config.metadata.sources), `Base config field "metadata.sources" must be an array`)
    assert(config.metadata.sources[0].name === 'default', `The first source in the base metadata config must be "default"`)
}


type RelationshipRecord = {
    from: string
    name: string
    field: string
    to: string
    oneToOne: boolean
    inverseRelationshipName?: string
}


function getTablesData(metadata: MetadataArgsStorage): string[] {
    return metadata.tables.map(t => tableName(t.target))
}


function tableName(entityTarget: string | Function): string {
    if (typeof entityTarget === 'string') {
        return entityTarget
    }
    else {
        return toSnakeCase(entityTarget.name)
    }
}


function getRelationshipsData(metadata: MetadataArgsStorage): RelationshipRecord[] {
    const out: RelationshipRecord[] = []

    for (let rel of metadata.relations) {
        // relationships marked as one-to-many are derived but optional;
        // their name and presence is identified via the inversePresent flag on the second pass
        if (rel.relationType === 'many-to-one') {
            out.push({
                from: tableName(rel.target),
                name: rel.propertyName,
                field: `${toSnakeCase(rel.propertyName)}_id`,
                to: typeToTableName(rel.type),
                oneToOne: false,
                inverseRelationshipName: undefined
            })
        }
        // names of the inverse one-to-one relationships are identified on the second pass
        if (rel.relationType === 'one-to-one' && rel.inverseSideProperty === undefined) {
            out.push({
                from: tableName(rel.target),
                name: rel.propertyName,
                field: `${toSnakeCase(rel.propertyName)}_id`,
                to: typeToTableName(rel.type),
                oneToOne: true,
                inverseRelationshipName: undefined
            })
        }
    }

    // doing the second pass to set names of all inverse relationships
    for (let rel of metadata.relations) {
        if (rel.relationType === 'one-to-many') {
            const from = tableName(rel.target)
            const type = typeToTableName(rel.type)
            const inversePropertyName = inverseSidePropertyToPropertyName(rel.inverseSideProperty!)

            const recordToUpdate = out.find(r => (
                r.from === type &&
                r.name === inversePropertyName &&
                r.to === from &&
                !r.oneToOne
            ))

            if (recordToUpdate === undefined) {
                console.log('WARNING! Found a one-to-many relationship that not mathing any many-to-one relationships\n', rel, '\nSkipping')
            }
            else {
                recordToUpdate.inverseRelationshipName = rel.propertyName
            }
        }
        if (rel.relationType === 'one-to-one' && rel.inverseSideProperty !== undefined) {
            const from = tableName(rel.target)
            const type = typeToTableName(rel.type)
            const inversePropertyName = inverseSidePropertyToPropertyName(rel.inverseSideProperty!)

            const recordToUpdate = out.find(r => (
                r.from === type &&
                r.name === inversePropertyName &&
                r.to === from &&
                r.oneToOne
            ))

            if (recordToUpdate === undefined) {
                console.log('WARNING! Found a one-to-many relationship that not mathing any many-to-one relationships\n', rel, '\nSkipping')
            }
            else {
                recordToUpdate.inverseRelationshipName = rel.propertyName
            }
        }
    }

    return out
}


function inverseSidePropertyToPropertyName(prop: PropertyTypeFactory<any>): string {
    try {
        let callableType: any = prop
        let propName = callableType.toString().split('.')[1] // a typical body of these functions reads 'e => e.<propName>'
        // Hacky! But this is the best option available in TypeORM
        // If you know a better way, open an issue at https://github.com/subsquid/hasura-configuration/
        assert(propName)
        return propName as string
    }
    catch (e) {
        console.error(`Unexpected value returned by TypeORM for an inverse side property`, e, prop)
        process.exit(1)
    }
}


function typeToTableName(rtype: RelationTypeInFunction): string {
    try {
        let callableType: any = rtype
        let tableName = callableType().name
        assert(tableName)
        return toSnakeCase(tableName as string)
    }
    catch (e) {
        console.error(`Unexpected value returned by TypeORM for a relation type`, e, rtype)
        process.exit(1)
    }
}


function makeHasuraTablesConfig(tables: string[]): any[] {
    return tables.map(t => ({table: {name: t, schema: 'public'}}))
}


function updateHasuraTablesWithRelationshipsConfig(hasuraTables: any[], relationships: RelationshipRecord[]): any[] {
    const arrayRelationships: Map<string, any[]> = new Map()
    const objectRelationships: Map<string, any[]> = new Map()
    for (let rel of relationships) {
        if (rel.oneToOne) {
            updateArrayMap(objectRelationships, rel.from, {
                name: rel.name,
                using: {
                    foreign_key_constraint_on: rel.field
                }
            })
            if (rel.inverseRelationshipName !== undefined) {
                updateArrayMap(objectRelationships, rel.to, {
                    name: rel.inverseRelationshipName,
                    using: {
                        foreign_key_constraint_on: {
                            column: rel.field,
                            table: {
                                name: rel.from,
                                schema: 'public'
                            }
                        }
                    }
                })
            }
        }
        else {
            updateArrayMap(objectRelationships, rel.from, {
                name: rel.name,
                using: {
                    foreign_key_constraint_on: rel.field
                }
            })
            if (rel.inverseRelationshipName !== undefined) {
                updateArrayMap(arrayRelationships, rel.to, {
                    name: rel.inverseRelationshipName,
                    using: {
                        foreign_key_constraint_on: {
                            column: rel.field,
                            table: {
                                name: rel.from,
                                schema: 'public'
                            }
                        }
                    }
                })
            }
        }
    }

    return hasuraTables.map(t => {
        const tname = t.table.name
        if (arrayRelationships.has(tname)) {
            t.array_relationships = arrayRelationships.get(tname)
        }
        if (objectRelationships.has(tname)) {
            t.object_relationships = objectRelationships.get(tname)
        }
        return t
    })
}


function updateArrayMap<T>(m: Map<string, T[]>, key: string, value: T): void {
    if (m.has(key)) {
        m.get(key)!.push(value)
    }
    else {
        m.set(key, [value])
    }
}

function updateHasuraTablesWithPermissionsConfig(hasuraTables: any[]): any[] {
    return hasuraTables.map(t => ({
        ...t,
        select_permissions: [
            {
                role: HASURA_GRAPHQL_UNAUTHORIZED_ROLE,
                permission: {
                    columns: "*",
                    filter: {},
                    allow_aggregations: true
                }
            }
        ]
    }))
}
