import { Entity } from "../../../../../src/decorator/entity/Entity"
import { PrimaryGeneratedColumn } from "../../../../../src/decorator/columns/PrimaryGeneratedColumn"
import { Post } from "./Post"
import { Column } from "../../../../../src/decorator/columns/Column"
import { ManyToOne } from "../../../../../src/decorator/relations/ManyToOne"
import { ManyToMany } from "../../../../../src/decorator/relations/ManyToMany"

@Entity()
export class Category {
    @PrimaryGeneratedColumn()
    id: number

    @Column()
    name: string

    @ManyToOne(() => Post, (post) => post.categories)
    post: Post

    @ManyToMany((type) => Post, (post) => post.manyCategories)
    manyPosts: Post[]
}
