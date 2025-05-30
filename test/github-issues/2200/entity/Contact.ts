import {
    Entity,
    PrimaryGeneratedColumn,
    OneToMany,
} from "../../../../src/index"
import { Booking } from "./Booking"

@Entity()
export class Contact {
    @PrimaryGeneratedColumn()
    id: number

    @OneToMany(() => Booking, (booking) => booking.contact)
    bookings: Booking[]
}
