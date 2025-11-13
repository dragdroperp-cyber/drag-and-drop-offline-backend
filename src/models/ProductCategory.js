const mongoose = require("mongoose");
const ProductCategory = new mongoose.Schema({
        sellerId:{
            type:mongoose.Schema.Types.ObjectId,
            required:true,
            ref:"Seller"
        },
        name:{
            type:String,
            required:true
        },
        isActive:{
            type:Boolean,
            default:true
        },
        description:String
})

module.exports = mongoose.model("ProductCategory",ProductCategory);