import { Table, Column, Model, DataType } from 'sequelize-typescript';

@Table({ tableName: 'tasks' })
export class Task extends Model {
    @Column({
        type: DataType.INTEGER,
        primaryKey: true,
        autoIncrement: true
    })
        // @ts-ignore
    id: number; // Явное объявление ID
    @Column({
        type: DataType.ENUM('pending', 'processing', 'completed', 'failed'),
        defaultValue: 'pending'
    })
    status: string;

    @Column(DataType.STRING)
    s3Key: string;

    @Column(DataType.INTEGER)
    urlsCount: number;

    @Column(DataType.INTEGER)
    completed: number;

    @Column(DataType.DATE)
    processedAt: Date;
}