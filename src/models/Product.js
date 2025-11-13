const mongoose  = require("mongoose");
const ProductSchema = new mongoose.Schema({
    sellerId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Seller",
        required:true
    },
    name:{
        type:String,
        required:true
    },
    barcode:{
        type:String,
        required:false,
        default:''
    },
    categoryId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"ProductCategory",
    },
    stock:{
        type:Number,
        required:true
    },
    unit:{
        type:String,
        required:true
    },
    lowStockLevel:{
        type:Number,
        default:10
    },
    costPrice:{
        type:Number,
        required:true
    },
    sellingUnitPrice:{
        type:Number,
        required:true
    },
    mfg:{
        type:Date,
        required:true
    },
    expiryDate:{
        type:Date,
        required:true
    },
    description:{
        type:String,
        required:true
    },
    isActive:{
        type:Boolean,
        default:false
    }


})

module.exports = mongoose.model("Product",ProductSchema);