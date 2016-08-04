import {Connection} from "../connection/Connection";
import {EntityMetadata} from "../metadata/EntityMetadata";
import {QueryBuilder} from "../query-builder/QueryBuilder";
import {PlainObjectToNewEntityTransformer} from "../query-builder/transformer/PlainObjectToNewEntityTransformer";
import {PlainObjectToDatabaseEntityTransformer} from "../query-builder/transformer/PlainObjectToDatabaseEntityTransformer";
import {EntityPersistOperationBuilder} from "../persistment/EntityPersistOperationsBuilder";
import {PersistOperationExecutor} from "../persistment/PersistOperationExecutor";
import {EntityWithId} from "../persistment/operation/PersistOperation";
import {FindOptions, FindOptionsUtils} from "./FindOptions";
import {EntityMetadataCollection} from "../metadata-args/collection/EntityMetadataCollection";
import {Broadcaster} from "../subscriber/Broadcaster";
import {Driver} from "../driver/Driver";
import {ObjectLiteral} from "../common/ObjectLiteral";

/**
 * Repository is supposed to work with your entity objects. Find entities, insert, update, delete, etc.
 */
export class Repository<Entity extends ObjectLiteral> {

    // -------------------------------------------------------------------------
    // Private Properties
    // -------------------------------------------------------------------------

    protected driver: Driver;
    protected persistOperationExecutor: PersistOperationExecutor;
    protected entityPersistOperationBuilder: EntityPersistOperationBuilder;
    protected plainObjectToEntityTransformer: PlainObjectToNewEntityTransformer;
    protected plainObjectToDatabaseEntityTransformer: PlainObjectToDatabaseEntityTransformer<Entity>;
    
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(protected connection: Connection,
                protected broadcaster: Broadcaster,
                protected entityMetadatas: EntityMetadataCollection,
                protected metadata: EntityMetadata) {
        this.driver = connection.driver;
        this.persistOperationExecutor = new PersistOperationExecutor(connection.driver, entityMetadatas, this.broadcaster);
        this.entityPersistOperationBuilder = new EntityPersistOperationBuilder(entityMetadatas);
        this.plainObjectToEntityTransformer = new PlainObjectToNewEntityTransformer();
        this.plainObjectToDatabaseEntityTransformer = new PlainObjectToDatabaseEntityTransformer();
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Returns object that is managed by this repository.
     * If this repository manages entity from schema, then it returns a name of that schema instead.
     */
    get target(): Function|string {
        return this.metadata.target;
    }

    /**
     * Checks if entity has an id.
     */
    hasId(entity: Entity): boolean {
        const columnName = this.metadata.primaryColumn.propertyName;
        return !!entity &&
            entity.hasOwnProperty(columnName) &&
            entity[columnName] !== null &&
            entity[columnName] !== undefined &&
            entity[columnName] !== "";
    }

    /**
     * Creates a new query builder that can be used to build a sql query.
     */
    createQueryBuilder(alias: string): QueryBuilder<Entity> {
        return new QueryBuilder(this.driver, this.entityMetadatas, this.broadcaster)
            .select(alias)
            .from(this.metadata.target, alias);
    }

    /**
     * Creates a new entity instance.
     */
    create(): Entity;

    /**
     * Creates a new entities and copies all entity properties from given objects into their new entities.
     * Note that it copies only properties that present in entity schema.
     */
    create(plainObjects: Object[]): Entity[];

    /**
     * Creates a new entity instance and copies all entity properties from this object into a new entity.
     * Note that it copies only properties that present in entity schema.
     */
    create(plainObject: Object): Entity;

    /**
     * Creates a new entity instance or instances.
     * Can copy properties from the given object into new entities.
     */
    create(plainObjectOrObjects?: Object|Object[]): Entity|Entity[] {
        if (plainObjectOrObjects instanceof Array) {
            return plainObjectOrObjects.map(object => this.create(object as Object));
        }

        const newEntity: Entity = this.metadata.create();
        if (plainObjectOrObjects)
            this.plainObjectToEntityTransformer.transform(newEntity, plainObjectOrObjects, this.metadata);

        return newEntity;
    }

    /**
     * Creates a new entity from the given plan javascript object. If entity already exist in the database, then
     * it loads it (and everything related to it), replaces all values with the new ones from the given object
     * and returns this new entity. This new entity is actually a loaded from the db entity with all properties
     * replaced from the new object.
     */
    preload(object: Object): Promise<Entity> {
        const queryBuilder = this.createQueryBuilder(this.metadata.table.name);
        return this.plainObjectToDatabaseEntityTransformer.transform(object, this.metadata, queryBuilder);
    }

    /**
     * Merges multiple entities (or entity-like objects) into one new entity.
     */
    merge(...objects: ObjectLiteral[]): Entity {
        const newEntity = this.create();
        objects.forEach(object => this.plainObjectToEntityTransformer.transform(newEntity, object, this.metadata));
        return newEntity;
    }

    /**
     * Persists (saves) all given entities in the database.
     * If entities do not exist in the database then inserts, otherwise updates.
     */
    async persist(entities: Entity[]): Promise<Entity[]>;

    /**
     * Persists (saves) a given entity in the database.
     * If entity does not exist in the database then inserts, otherwise updates.
     */
    async persist(entity: Entity): Promise<Entity>;

    /**
     * Persists one or many given entities.
     */
    async persist(entityOrEntities: Entity|Entity[]): Promise<Entity|Entity[]> {

        // if multiple entities given then go throw all of them and save them
        if (entityOrEntities instanceof Array)
            return Promise.all(entityOrEntities.map(entity => this.persist(entity)));

        // resolve is required because need to wait until lazy relations loaded
        await Promise.resolve();

        const allPersistedEntities = await this.extractObjectsById(entityOrEntities, this.metadata);
        let loadedDbEntity: Entity|null = null;
        if (this.hasId(entityOrEntities))
            loadedDbEntity = await this.preload(entityOrEntities);

        let entityWithIds: EntityWithId[] = [];
        if (loadedDbEntity)
            entityWithIds = await this.extractObjectsById(loadedDbEntity, this.metadata);

        // need to find db entities that were not loaded by initialize method
        const allDbEntities = await this.findNotLoadedIds(entityWithIds, allPersistedEntities);
        const persistedEntity: EntityWithId = {
            id: this.metadata.getEntityId(entityOrEntities),
            entityTarget: this.metadata.target,
            entity: entityOrEntities
        };
        const dbEntity: EntityWithId = {
            id: this.metadata.getEntityId(loadedDbEntity),
            entityTarget: this.metadata.target,
            entity: loadedDbEntity
        };
        const persistOperation = await this.entityPersistOperationBuilder.buildFullPersistment(this.metadata, dbEntity, persistedEntity, allDbEntities, allPersistedEntities);
        await this.persistOperationExecutor.executePersistOperation(persistOperation);
        return entityOrEntities;
    }

    /**
     * Removes a given entities from the database.
     */
    async remove(entities: Entity[]): Promise<Entity[]>;

    /**
     * Removes a given entity from the database.
     */
    async remove(entity: Entity): Promise<Entity>;

    /**
     * Removes one or many given entities.
     */
    async remove(entityOrEntities: Entity|Entity[]): Promise<Entity|Entity[]> {

        // if multiple entities given then go throw all of them and save them
        if (entityOrEntities instanceof Array)
            return Promise.all(entityOrEntities.map(entity => this.remove(entity)));

        const dbEntity = await this.preload(entityOrEntities);
        (<any> entityOrEntities)[this.metadata.primaryColumn.name] = undefined;
        const [dbEntities, allPersistedEntities] = await Promise.all([
            this.extractObjectsById(dbEntity, this.metadata),
            this.extractObjectsById(entityOrEntities, this.metadata)
        ]);
        const entityWithId: EntityWithId = {
            id: this.metadata.getEntityId(entityOrEntities),
            entityTarget: this.metadata.target,
            entity: entityOrEntities
        };
        const dbEntityWithId: EntityWithId = {
            id: this.metadata.getEntityId(dbEntity),
            entityTarget: this.metadata.target,
            entity: dbEntity
        };
        
        const persistOperation = this.entityPersistOperationBuilder.buildOnlyRemovement(this.metadata, dbEntityWithId, entityWithId, dbEntities, allPersistedEntities);
        await this.persistOperationExecutor.executePersistOperation(persistOperation);
        return entityOrEntities;
    }

    /**
     * Finds all entities.
     */
    async find(): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions.
     */
    async find(conditions: Object): Promise<Entity[]>;

    /**
     * Finds entities with given find options.
     */
    async find(options: FindOptions): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions and find options.
     */
    async find(conditions: Object, options: FindOptions): Promise<Entity[]>;

    /**
     * Finds entities that match given conditions and/or find options.
     */
    async find(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<Entity[]> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getResults();
    }

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditions: Object): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(options: FindOptions): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditions: Object, options: FindOptions): Promise<[ Entity[], number ]>;

    /**
     * Finds entities that match given conditions.
     */
    async findAndCount(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<[ Entity[], number ]> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getResultsAndCount();
    }

    /**
     * Finds first entity that matches given conditions.
     */
    async findOne(): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions.
     */
    async findOne(conditions: Object): Promise<Entity>;

    /**
     * Finds first entity that matches given find options.
     */
    async findOne(options: FindOptions): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions and find options.
     */
    async findOne(conditions: Object, options: FindOptions): Promise<Entity>;

    /**
     * Finds first entity that matches given conditions and/or find options.
     */
    async findOne(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions): Promise<Entity> {
        return this.createFindQueryBuilder(conditionsOrFindOptions, options)
            .getSingleResult();
    }

    /**
     * Finds entity with given id.
     */
    async findOneById(id: any, options?: FindOptions): Promise<Entity> {
        return this.createFindQueryBuilder({ [this.metadata.primaryColumn.name]: id }, options)
            .getSingleResult();
    }

    /**
     * Executes a raw SQL query and returns a raw database results.
     */
    async query(query: string): Promise<any> {
        return this.driver.query(query);
    }

    /**
     * Wraps given function execution (and all operations made there) in a transaction.
     */
    async transaction(runInTransaction: () => Promise<any>|any): Promise<any> {
        let runInTransactionResult: any;
        return this.driver
            .beginTransaction()
            .then(() => runInTransaction())
            .then(result => {
                runInTransactionResult = result;
                return this.driver.commitTransaction();
            })
            .catch(err => {
                return this.driver.rollbackTransaction()
                    .then(() => {
                        throw err;
                    })
                    .catch(() => {
                        throw err;
                    });
            })
            .then(() => runInTransactionResult);
    }

    /**
     * Sets given relatedEntityId to the value of the relation of the entity with entityId id.
     * Should be used when you want quickly and efficiently set a relation (for many-to-one and one-to-many) to some entity.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async setRelation(relationName: string, entityId: any, relatedEntityId: any): Promise<void>;
    async setRelation(relationName: ((t: Entity) => string|any), entityId: any, relatedEntityId: any): Promise<void>;
    async setRelation(relationName: string|((t: Entity) => string|any), entityId: any, relatedEntityId: any): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        // if (relation.isManyToMany || relation.isOneToMany || relation.isOneToOneNotOwner)
        //     throw new Error(`Only many-to-one and one-to-one with join column are supported for this operation. ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);
        if (relation.isManyToMany)
            throw new Error(`Many-to-many relation is not supported for this operation. Use #addToRelation method for many-to-many relations.`);

        let table: string, values: any = {}, conditions: any = {};
        if (relation.isOwning) {
            table = relation.entityMetadata.table.name;
            values[relation.name] = relatedEntityId;
            conditions[relation.joinColumn.referencedColumn.name] = entityId;
        } else {
            table = relation.inverseEntityMetadata.table.name;
            values[relation.inverseRelation.name] = relatedEntityId;
            conditions[relation.inverseRelation.joinColumn.referencedColumn.name] = entityId;
        }
        return this.driver.update(table, values, conditions).then(() => {});
    }

    /**
     * Sets given relatedEntityId to the value of the relation of the entity with entityId id.
     * Should be used when you want quickly and efficiently set a relation (for many-to-one and one-to-many) to some entity.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async setInverseRelation(relationName: string, relatedEntityId: any, entityId: any): Promise<void>;
    async setInverseRelation(relationName: ((t: Entity) => string|any), relatedEntityId: any, entityId: any): Promise<void>;
    async setInverseRelation(relationName: string|((t: Entity) => string|any), relatedEntityId: any, entityId: any): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        // if (relation.isManyToMany || relation.isOneToMany || relation.isOneToOneNotOwner)
        //     throw new Error(`Only many-to-one and one-to-one with join column are supported for this operation. ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);
        if (relation.isManyToMany)
            throw new Error(`Many-to-many relation is not supported for this operation. Use #addToRelation method for many-to-many relations.`);

        let table: string, values: any = {}, conditions: any = {};
        if (relation.isOwning) {
            table = relation.inverseEntityMetadata.table.name;
            values[relation.inverseRelation.name] = relatedEntityId;
            conditions[relation.inverseRelation.joinColumn.referencedColumn.name] = entityId;
        } else {
            table = relation.entityMetadata.table.name;
            values[relation.name] = relatedEntityId;
            conditions[relation.joinColumn.referencedColumn.name] = entityId;
        }
        return this.driver.update(table, values, conditions).then(() => {});
    }

    /**
     * Adds a new relation between two entities into relation's many-to-many table.
     * Should be used when you want quickly and efficiently add a relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async addToRelation(relationName: string, entityId: any, relatedEntityIds: any[]): Promise<void>;
    async addToRelation(relationName: ((t: Entity) => string|any), entityId: any, relatedEntityIds: any[]): Promise<void>;
    async addToRelation(relationName: string|((t: Entity) => string|any), entityId: any, relatedEntityIds: any[]): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        if (!relation.isManyToMany)
            throw new Error(`Only many-to-many relation supported for this operation. However ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);

        const insertPromises = relatedEntityIds.map(relatedEntityId => {
            const values: any = { };
            if (relation.isOwning) {
                values[relation.junctionEntityMetadata.columns[0].name] = entityId;
                values[relation.junctionEntityMetadata.columns[1].name] = relatedEntityId;
            } else {
                values[relation.junctionEntityMetadata.columns[1].name] = entityId;
                values[relation.junctionEntityMetadata.columns[0].name] = relatedEntityId;
            }

            return this.driver.insert(relation.junctionEntityMetadata.table.name, values);
        });
        return Promise.all(insertPromises).then(() => {});
    }

    /**
     * Adds a new relation between two entities into relation's many-to-many table from inverse side of the given relation.
     * Should be used when you want quickly and efficiently add a relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async addToInverseRelation(relationName: string, relatedEntityId: any, entityIds: any[]): Promise<void>;
    async addToInverseRelation(relationName: ((t: Entity) => string|any), relatedEntityId: any, entityIds: any[]): Promise<void>;
    async addToInverseRelation(relationName: string|((t: Entity) => string|any), relatedEntityId: any, entityIds: any[]): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        if (!relation.isManyToMany)
            throw new Error(`Only many-to-many relation supported for this operation. However ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);

        const insertPromises = entityIds.map(entityId => {
            const values: any = { };
            if (relation.isOwning) {
                values[relation.junctionEntityMetadata.columns[0].name] = entityId;
                values[relation.junctionEntityMetadata.columns[1].name] = relatedEntityId;
            } else {
                values[relation.junctionEntityMetadata.columns[1].name] = entityId;
                values[relation.junctionEntityMetadata.columns[0].name] = relatedEntityId;
            }

            return this.driver.insert(relation.junctionEntityMetadata.table.name, values);
        });
        return Promise.all(insertPromises).then(() => {});
    }

    /**
     * Removes a relation between two entities from relation's many-to-many table.
     * Should be used when you want quickly and efficiently remove a many-to-many relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async removeFromRelation(relationName: string, entityId: any, relatedEntityIds: any[]): Promise<void>;
    async removeFromRelation(relationName: ((t: Entity) => string|any), entityId: any, relatedEntityIds: any[]): Promise<void>;
    async removeFromRelation(relationName: string|((t: Entity) => string|any), entityId: any, relatedEntityIds: any[]): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        if (!relation.isManyToMany)
            throw new Error(`Only many-to-many relation supported for this operation. However ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);

        // check if given relation entity ids is empty - then nothing to do here (otherwise next code will remove all ids)
        if (!relatedEntityIds || !relatedEntityIds.length)
            return Promise.resolve();

        const qb = this.createQueryBuilder("junctionEntity")
            .delete(relation.junctionEntityMetadata.table.name);

        const firstColumnName = relation.isOwning ? relation.junctionEntityMetadata.columns[0].name : relation.junctionEntityMetadata.columns[1].name;
        const secondColumnName = relation.isOwning ? relation.junctionEntityMetadata.columns[1].name : relation.junctionEntityMetadata.columns[0].name;

        relatedEntityIds.forEach((relatedEntityId, index) => {
            qb.orWhere(`(${firstColumnName}=:entityId AND ${secondColumnName}=:relatedEntity_${index})`)
                .setParameter("relatedEntity_" + index, relatedEntityId);
        });

        return qb
            .setParameter("entityId", entityId)
            .execute()
            .then(() => {});
    }

    /**
     * Removes a relation between two entities from relation's many-to-many table.
     * Should be used when you want quickly and efficiently remove a many-to-many relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async removeFromInverseRelation(relationName: string, relatedEntityId: any, entityIds: any[]): Promise<void>;
    async removeFromInverseRelation(relationName: ((t: Entity) => string|any), relatedEntityId: any, entityIds: any[]): Promise<void>;
    async removeFromInverseRelation(relationName: string|((t: Entity) => string|any), relatedEntityId: any, entityIds: any[]): Promise<void> {
        const propertyName = this.metadata.computePropertyName(relationName);
        if (!this.metadata.hasRelationWithPropertyName(propertyName))
            throw new Error(`Relation ${propertyName} was not found in the ${this.metadata.name} entity.`);

        const relation = this.metadata.findRelationWithPropertyName(propertyName);
        if (!relation.isManyToMany)
            throw new Error(`Only many-to-many relation supported for this operation. However ${this.metadata.name}#${propertyName} relation type is ${relation.relationType}`);

        // check if given entity ids is empty - then nothing to do here (otherwise next code will remove all ids)
        if (!entityIds || !entityIds.length)
            return Promise.resolve();

        const qb = this.createQueryBuilder("junctionEntity")
            .delete(relation.junctionEntityMetadata.table.name);

        const firstColumnName = relation.isOwning ? relation.junctionEntityMetadata.columns[1].name : relation.junctionEntityMetadata.columns[0].name;
        const secondColumnName = relation.isOwning ? relation.junctionEntityMetadata.columns[0].name : relation.junctionEntityMetadata.columns[1].name;

        entityIds.forEach((entityId, index) => {
            qb.orWhere(`(${firstColumnName}=:relatedEntityId AND ${secondColumnName}=:entity_${index})`)
              .setParameter("entity_" + index, entityId);
        });

        await qb.setParameter("relatedEntityId", relatedEntityId).execute();
    }

    /**
     * Performs both #addToRelation and #removeFromRelation operations.
     * Should be used when you want quickly and efficiently and and remove a many-to-many relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async addAndRemoveFromRelation(relation: string, entityId: any, addRelatedEntityIds: any[], removeRelatedEntityIds: any[]): Promise<void>;
    async addAndRemoveFromRelation(relation: ((t: Entity) => string|any), entityId: any, addRelatedEntityIds: any[], removeRelatedEntityIds: any[]): Promise<void>;
    async addAndRemoveFromRelation(relation: string|((t: Entity) => string|any), entityId: any, addRelatedEntityIds: any[], removeRelatedEntityIds: any[]): Promise<void> {
        await Promise.all([
            this.addToRelation(relation as any, entityId, addRelatedEntityIds),
            this.removeFromRelation(relation as any, entityId, removeRelatedEntityIds)
        ]);
    }

    /**
     * Performs both #addToRelation and #removeFromRelation operations.
     * Should be used when you want quickly and efficiently and and remove a many-to-many relation between two entities.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async addAndRemoveFromInverseRelation(relation: string, relatedEntityId: any, addEntityIds: any[], removeEntityIds: any[]): Promise<void>;
    async addAndRemoveFromInverseRelation(relation: ((t: Entity) => string|any), relatedEntityId: any, addEntityIds: any[], removeEntityIds: any[]): Promise<void>;
    async addAndRemoveFromInverseRelation(relation: string|((t: Entity) => string|any), relatedEntityId: any, addEntityIds: any[], removeEntityIds: any[]): Promise<void> {
        await Promise.all([
            this.addToInverseRelation(relation as any, relatedEntityId, addEntityIds),
            this.removeFromInverseRelation(relation as any, relatedEntityId, removeEntityIds)
        ]);
    }

    /**
     * Removes entity with the given id.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async removeById(id: any) {
        const alias = this.metadata.table.name;
        await this.createQueryBuilder(alias)
            .delete()
            .where(alias + "." + this.metadata.primaryColumn.propertyName + "=:id", { id: id })
            .execute();
    }

    /**
     * Removes all entities with the given ids.
     * Note that event listeners and event subscribers won't work (and will not send any events) when using this operation.
     */
    async removeByIds(ids: any[]) {
        const alias = this.metadata.table.name;
        await this.createQueryBuilder(alias)
            .delete()
            .where(alias + "." + this.metadata.primaryColumn.propertyName + " IN (:ids)", { ids: ids })
            .execute();
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    private createFindQueryBuilder(conditionsOrFindOptions?: Object|FindOptions, options?: FindOptions) {
        const findOptions = FindOptionsUtils.isFindOptions(conditionsOrFindOptions) ? conditionsOrFindOptions : <FindOptions> options;
        const conditions = FindOptionsUtils.isFindOptions(conditionsOrFindOptions) ? undefined : conditionsOrFindOptions;

        const alias = findOptions ? findOptions.alias : this.metadata.table.name;
        const qb = this.createQueryBuilder(alias);
        if (findOptions) {
            FindOptionsUtils.applyOptionsToQueryBuilder(qb, findOptions);
        }
        if (conditions) {
            Object.keys(conditions).forEach(key => {
                const name = key.indexOf(".") === -1 ? alias + "." + key : key;
                qb.andWhere(name + "=:" + key);
            });
            qb.addParameters(conditions);
        }
        return qb;
    }

    /**
     * When ORM loads dbEntity it uses joins to load all entity dependencies. However when dbEntity is newly persisted
     * to the db, but uses already exist in the db relational entities, those entities cannot be loaded, and will
     * absent in dbEntities. To fix it, we need to go throw all persistedEntities we have, find out those which have
     * ids, check if we did not load them yet and try to load them. This algorithm will make sure that all dbEntities
     * are loaded. Further it will help insert operations to work correctly.
     */
    private findNotLoadedIds(dbEntities: EntityWithId[], persistedEntities: EntityWithId[]): Promise<EntityWithId[]> {
        const missingDbEntitiesLoad = persistedEntities
            .filter(entityWithId => entityWithId.id !== null && entityWithId.id !== undefined)
            .filter(entityWithId => !dbEntities.find(dbEntity => dbEntity.entityTarget === entityWithId.entityTarget && dbEntity.id === entityWithId.id))
            .map(entityWithId => {
                const metadata = this.entityMetadatas.findByTarget(entityWithId.entityTarget);
                const repository = this.connection.getRepository(entityWithId.entityTarget as any); // todo: fix type
                return repository.findOneById(entityWithId.id).then(loadedEntity => {
                    if (!loadedEntity) return undefined;

                    return <EntityWithId> {
                        id: (<any> loadedEntity)[metadata.primaryColumn.name],
                        entityTarget: metadata.target,
                        entity: loadedEntity
                    };
                });
            });

        return Promise.all<EntityWithId>(missingDbEntitiesLoad).then(missingDbEntities => {
            return dbEntities.concat(missingDbEntities.filter(dbEntity => !!dbEntity));
        });
    }

    /**
     * Extracts unique objects from given entity and all its downside relations.
     */
    private extractObjectsById(entity: any, metadata: EntityMetadata, entityWithIds: EntityWithId[] = []): Promise<EntityWithId[]> {
        const promises = metadata.relations.map(relation => {
            const relMetadata = relation.inverseEntityMetadata;

            const value = relation.isLazy ? entity["__" + relation.propertyName + "__"] : entity[relation.propertyName];
            if (!value)
                return undefined;
            
            if (value instanceof Array) {
                const subPromises = value.map((subEntity: any) => {
                    return this.extractObjectsById(subEntity, relMetadata, entityWithIds);
                });
                return Promise.all(subPromises);
                
            } else {
                return this.extractObjectsById(value, relMetadata, entityWithIds);
            }
        });
        
        return Promise.all<any>(promises.filter(result => !!result)).then(() => {
            if (!entityWithIds.find(entityWithId => entityWithId.entity === entity)) {
                entityWithIds.push({
                    id: entity[metadata.primaryColumn.name],
                    entityTarget: metadata.target,
                    entity: entity
                });
            }

            return entityWithIds;
        });
    }

    // -------------------------------------------------------------------------
    // Static Methods
    // -------------------------------------------------------------------------

    /**
     * Checks if given repository owns given metadata.
     */
    static ownsMetadata(repository: Repository<any>, metadata: EntityMetadata) {
        return repository.metadata === metadata;
    }

}